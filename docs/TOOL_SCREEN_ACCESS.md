# Tool screen authorization

The assistant router now enforces the same **screen denylist** used by market-fit:
`site_members.blocked_screens`. Keys are the navigation IDs, not URL paths or
tool categories. Examples: `transactions`, `orders`, `leads`, `contentCreator`,
`applicationsSecrets`.

## Mapping

`src/app/api/agents/tools/router/tool-screen-map.json` is the versioned mapping.
Every production tool must have an explicit entry; unknown names are denied even
for administrators. `sandbox_` / `qa_` prefixes do not grant permission.

```json
{
  "transactions": { "screens": ["transactions"] },
  "sales_order": { "screens": ["orders"] },
  "purchases": { "screens": ["bills"] },
  "purchase_items": { "screens": ["bills"] },
  "create_site_secret": { "screens": ["applicationsSecrets"], "adminOnly": true },
  "webSearch": { "screens": null }
}
```

- **All** listed screens must be accessible. Multi-module tools such as `report`,
  `publish` and `calendars` deliberately require the union of their data surfaces.
  This is conservative: blocking one surface disables the entire tool. Narrower
  action/table-specific authorization can replace this later.
- `screens: null` explicitly identifies a utility without a blockable screen.
  It does not waive the tool's own authentication, billing or resource checks.
  Account/project entry points retain their own checks; `requiresUser` additionally
  requires current effective site access. Project switching is admin-only until
  its separate session/target authorization is tightened.
- `adminOnly` restricts privileged proxies (generic integrations, secrets, settings,
  shell commands) to owners/admins, preventing their use as alternate tool entry points.
  Lint, repository tests and validation also require admin access: repository
  configuration/plugins/test code can execute even without shell interpolation.
- `bindActor` rejects actor overrides on legacy instance/plan wrappers. Other
  tools may legitimately use `user_id` as a domain filter, not execution identity.
- `bindActorActions` applies the same check only to named actions. Requirements
  bind `create` to the host user; the wrapper requires that user and fixes the
  persisted creator independently of the router. `list.user_id` remains a filter.
- Supplier-bill headers, payments and lines use `bills`, not `purchasesOrders`.
- Lint executes installed workspace binaries directly with separate arguments
  and `cwd`, never `sh -c` or downloading `npx` packages. Explicit paths must be
  existing literal paths inside the workspace, including after symlink resolution;
  option injection, control characters and parent traversal are rejected.
- Explicit `site_id`/`siteId` overrides are rejected unless the rule specifically
  permits project switching. This applies even to administrators.

## Enforcement

`getAssistantTools` supplies its host-owned site/user scope to `routeTools`.
The scope is captured separately from model arguments and copied before routing.

For every router action, authorization reads current effective site access through
`site_user_has_effective_access`, ownership and active membership/blocked screens.
There is no positive permission cache. Lookup failures, timeouts, malformed
permission data, missing actors and ineffective/expired membership deny protected
tools. A legacy null denylist is treated as empty for an active authorized member.

Owners (`sites.user_id` or `site_ownership`) and active `owner`/`admin` members are
exempt from the denylist, **only after** effective site/license access succeeds.

- `list` and both semantic/keyword `search` omit denied tools.
- `describe` does not disclose denied tool schemas.
- `call` returns `success: false`, `code: TOOL_SCREEN_ACCESS_DENIED`, `status: 403`
  before invoking a denied tool. This is a tool-result status, not the transport's
  HTTP status; MCP/assistant transports keep their existing response format.
- Direct/always-on tools are wrapped in the same guard. Their schemas may still
  be advertised, but invocation throws a denial before the implementation runs.
- The single-turn executor applies `guardFinalToolCatalog` after all repair,
  history, status-noop and ownership decorators. Thus late `instance_history`,
  `sandbox_run_tests` and `sandbox_run_validation` definitions cannot bypass
  screen admission. Existing `tools` routers retain their per-underlying-tool
  checks, rather than being granted an unrestricted router mapping.
- Authenticated non-service assistant requests use the verified JWT/API-key actor,
  not `body.user_id` or an instance owner's ID. MCP similarly ignores a non-service
  caller's `x-mcp-user-id` and validates tenant access before building its server.
- Internal service callers can forward a server-resolved actor; they must derive it
  from their own authenticated session, not end-user input. MCP without a user ID
  cannot execute protected tools, even with the service key. Stdio identity is
  operator-provided configuration, not an end-user credential.

## Scope and limitations

This implements **screen gating**, not the complete role/row authorization model.
It does not reproduce per-action CRUD permissions, API-key read/write scopes,
`restrict_to_assigned_only`, or authorization for every referenced record ID.
Those checks still belong at their operation/data boundaries. Some legacy global
resource tools also require an independent tenant-isolation audit.

Direct HTTP tool endpoints, agentbase's separate tool evaluator, custom runtimes
that bypass `routeTools`, and schema-only workflow catalogs are outside this guard.
Data already loaded into assistant background/history is not removed by a tool
denylist. Do not treat this change as complete confidentiality enforcement across
all API entry points or preloaded model context.

No schema migration was added: `blocked_screens` is already consumed and written
by market-fit. Its live database schema was not inspected or changed. If a target
database lacks the column or effective-access RPC, protected tools fail closed;
install the application's existing schema before enabling that deployment.

## Offline validation

```sh
node node_modules/jest/bin/jest.js --config jest.ai.config.js --runInBand \
  --runTestsByPath \
  src/app/api/agents/tools/router/__tests__/tools-router.test.ts \
  src/app/api/agents/tools/router/__tests__/screen-access.test.ts \
  src/lib/security/__tests__/tool-request-principal.test.ts \
  src/app/api/mcp/__tests__/screen-principal.test.ts \
  src/app/api/agents/tools/sandbox/__tests__/sandbox-read-lints.test.ts
node node_modules/jest/bin/jest.js --config jest.harness.config.js --runInBand \
  --runTestsByPath \
  src/app/api/robots/instance/assistant/__tests__/route-lifecycle.test.ts \
  src/app/api/agents/tools/requirements/__tests__/original-instance.test.ts \
  src/app/api/cron/shared/__tests__/single-turn-diagnostic-context.test.ts
```

Coverage includes mapping completeness, unknown tools, discovery filtering,
execution denial without side effects, revocation, owner/admin behavior, failing
lookups, legacy null denylist, direct tools, actor spoofing and tenant overrides.
Regressions cover requirement creator persistence vs list filters, bills/payment
denial, safe lint invocation and permission checks on the final executor catalog.
Credentials in authentication tests are generated synthetically at runtime.