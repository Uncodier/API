# Connectors runtime and API

Local implementation, not deployed or live-provider validated (2026-11-19).
See the shared [implementation and rollout guide](/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/docs/CONNECTORS_IMPLEMENTATION.md),
[architecture](/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/docs/CONNECTORS_ARCHITECTURE.md)
and [access model](/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/docs/CONNECTORS_ACCESS_MODEL.md).

- `src/lib/connectors/` owns provider transport, lifecycle, permissions, domain
  discovery and the lazy concrete tool resolver. Each HTTP route verifies a user
  bearer; metadata/service headers never select an actor.
- Interactive Robots `tools` search/describe/call uses **one provider-direct runtime**.
  It consults account Policies, not a registry of executable toolkits or display
  profiles. Support, approval decisions and opening old private report choices
  remain separate, narrower consumers. The native `report` tool is unchanged.
- New verified accounts inherit access for eligible workspace members and active
  same-site agents. Account-level restrictions override inheritance. Legacy
  accounts retain explicit grants. Connecting an account or the historical read
  opt-in does not enable provider-direct execution. Once enrolled, `all` does not
  intersect the provider catalog with a manually reviewed slug list; `selected`
  permits only the saved IDs (empty permits none). Both require the same current
  actor, host, account binding, downstream resource scope and transport contract.
- `connector-crm-operations` and `connector-messaging` are bundled operational
  procedures. Domains and skill selection confer no authority.
- The catalogue applies the shared domain registry before paginating results.
  Unfiltered browsing still jumps directly to a provider page. Filtered queries
  read bounded metadata pages using the selected credential; Connected queries
  inspect only authorized, visible toolkits. Incomplete scans fail explicitly.
  `GET /api/connectors/domain-counts` applies search and tab without category or
  pagination. It counts distinct toolkits overall and once in each matching
  domain. The web loads this summary separately from the catalogue page.
- The direct REST v3.1 backend is chosen to pin execution versions. See
  [provider endpoint evidence](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/connectors/COMPOSIO_REST_CONTRACT.md).
  No SDK ambient credentials, proxy/file loaders or automatic execution fallback.
  Explicit server credential selection is BYOK-first, then `COMPOSIO_API_KEY`
  (legacy `COMPOSIO_PROJECT_API_KEY`) only when the BYOK row is absent. Platform
  connections additionally require `COMPOSIO_PROJECT_ID` and the trusted callback
  origin/verifier. The site UUID remains the provider user; never global `default`.
  BYOK project and callback verification now uses an exact, operator-managed private database
  row per site and encrypted credential revision, across toolkits (no runtime environment list).
  Apply `20261121031200_connector_provider_attestations.sql` and explicitly import only vetted
  tuples; follow **Provider setup prerequisites** in the shared implementation guide before
  switching readers. Migration commit gates previously saved BYOK receipts immediately. A
  registry withdrawal blocks subsequent account use; it never reconnects or changes grants.
- Legacy apps/integrations catalogue routes now return the new scoped safe DTOs,
  not the former `{ success, data }` response. External callers must authenticate
  with a verified user bearer and use the documented site query.
- Legacy ToolEvaluator unknown names now return an unavailable-tool error rather
  than executing through a global Composio `default` account. Existing known native
  tools retain their handlers. Unsupported hosts remain blocked.
- Eight migrations (`20261119220100` through `20261119220104`, plus
  `20261119223000`, `20261119223001`, `20261119223010`) require explicit
  application approval. Provider project/verifier attestation and callback origin
  configuration are deployment prerequisites; see the shared guide for variables.
- Actual server prompt agent and authenticated caller origin bind assistant use;
  queued/internal/legacy recovery execution cannot borrow owner or agent grants.
  Existing unverified pending work must be re-enqueued by its authenticated actor.
- Search pages use `connector_cursor` / `connector_next_cursor`, with optional
  exact `connector_id`; all pages recheck member/agent policy, never cursor authority.

### Contract checks for Robots tool calls

For private provider actions, Robots checks the current member, agent, account
and tool policy. The connected application enforces the credential's data
access. An upstream resource denial is not retried with another account. Native
business reads and writes are distinct from automatic authorization, arbitrary
network proxies, code execution, credential management or database administration.
See [provider-direct rollout and acceptance](CONNECTOR_PROVIDER_DIRECT.md).

An explicit `tools` search/list with `connector_id` or `tool_origin: "provider"` returns provider inventory, not native report suggestions, even on an outage or empty page. Without either filter or a selected account, native tools can still appear alongside provider candidates. The scoped Makinari metrics report is retired. Its former origin and qualified references are rejected, including on hosts without a connector gateway. They cannot fall back to native `report`.

Provider candidates and descriptions identify their origin, local connector UUID, toolkit and safe account suffix. Ask should clarify ambiguous accounts or data sources and keep the same exact reference and scope. A different credential or a native tool is not a fallback. See [source selection and account identity](CONNECTOR_PROVIDER_DIRECT.md#choosing-the-source-and-account-in-private-ask-local-contract) for the two-account example and the offline/live verification boundary. Historical private report choices retain their original authorization path.

A locally rejected call can return `INVALID_TOOL_ARGUMENTS` with `argument_issue`
(a declared path, rule and, where relevant, a type or bound), `executed: false`
and `automatic_retry: false`. Unknown keys are reported at their declared
parent, never by copying the submitted name; values, enum contents, tokens and
provider diagnostics are not part of a correction. The agent should correct
the arguments, keeping the account and requested scope. A changed version or
schema instead requires a fresh description. Neither response grants access.

Native tool preflight is conservative: unsupported schema constructs and
legacy wire representations defer to the tool's own validator. Provider-direct
dispatch separately validates the versioned schema, current authority and
technical capabilities. A
permission denial, an upstream quota or an uncertain dispatch is not a reason
to replay a call with different arguments. Public support keeps its minimal
unavailable response rather than exposing the member's private contract.

Offline validation:

```bash
npm test -- --config jest.connectors.config.js --runInBand
```

Unit/provider tests mock only test transport, never production routes. SQL/RLS
tests run from the web repository on disposable socket-only PostgreSQL. Live OAuth,
external account operations and deployment remain separate acceptance gates.

### Private connector action approvals

`20261120020000_connector_action_approvals.sql` must be applied after the connector
migrations before enabling private approvals. Migration and deployment are separate
operator steps. Do not interpret a missing migration as approval or retry execution.

The stored `require_approval` bit allows eligible missing-use requests; it does not gate fully authorized interactive calls. A persisted request returns `status: pending`, not tool output. Conversation
hosts have a request-only service with a trusted conversation/agent binding. An
ambiguous account, explicit restriction, unreviewed tool or unsupported input fails closed.
In an owned private Support thread, the assigned agent’s current use grant authorizes only reviewed Gmail and HubSpot reads on a member-visible account. Member screen restrictions still apply. Without independent member use permission the gateway returns completion only, never provider data. The public audience still requires its separate publication. Private Robots provider-direct descriptors, arbitrary SQL, code and network requests have no channel dispatch or output contract.

On request-only paths, a visible view-only member or active agent without an explicit use grant can
request when opted in. A hidden, disabled, revoked or expired restriction is never
a request grant. A manager checks and executes the pinned read with their own
account-use permission; the proposing actor and agent are separately revalidated.
Neither type of proposal uses a customer as a member or grants an agent permission
to poll for results. Public channel proposals remain restricted to the Gmail and HubSpot reads; database infrastructure metadata is not added to the channel tool vocabulary.

**Rollout:** review existing `require_approval=true` accounts with their managers
before enabling this behavior. It no longer imposes a mandatory human gate on
fully authorized private reads. Disable the action/host or remove use if that
would be inappropriate. The new policy needs no data rewrite. Legacy blind
`conversation` proposals lack the source actor distinction and are not actionable;
let them expire and request again from a bound host. The separate, explicitly
published support-title audience/label projection is unchanged.

- Review destinations are real conversation IDs. Channel-originated requests stay
  in their existing conversation. Interactive requests keep their immutable
  user/instance origin and a separate link to a persisted `internal_review`
  conversation. This does not authorize customer delivery or provider dispatch.
  Apply `20261120060000_connector_review_conversations.sql` before the API projection.
- `GET /api/connectors/approvals?site_id=<uuid>`: authenticated manager, actionable
  private queue. Items contain `id`, `connector_id`, `agent_id`, `account_label`,
  `tool_slug`, `arguments`, `version`, `created_at`, `expires_at`, nullable origin `conversation_id`, `review_conversation_id`, and safe thread context. Only a verified triggering message may supply the excerpt. The internal workspace renders review controls in Conversations, never in customer delivery.
- `POST /api/connectors/approvals/<uuid>/approve` or `/reject`: verified user bearer,
  JSON body exactly `{ "site_id": "<uuid>" }`. The actor and arguments cannot be
  supplied or replaced by headers, model parameters or request metadata. The actor
  must have manager AND account-use access. A service key is not an actor.
- The stored snapshot pins the account/provider/policy revisions, original agent,
  arguments, toolkit version, schema hash and scopes. Interactive proposals also
  recheck the original member's access and instance. Grant, account, credential,
  manager, business-screen and conversation bindings are rechecked as applicable,
  including directly before dispatch. Approval is consumed atomically once;
  rejection never dispatches. A timeout/crash is **not** permission to retry.
- Rejection returns `{id,status:"rejected"}`. Only the successful approving HTTP
  request returns `{id,status:"completed",result}` with redacted provider data,
  or `result_omitted:true` instead of `result` above 32 KiB. No result is stored,
  replayed, inserted in messages, or sent to the customer or requesting agent.
  The approver can interpret the read and compose their own reply independently.

### Where a conversation agent can request review

`request_connector_review` accepts only `tool_slug` (static reviewed vocabulary)
plus `arguments`. The channel never lists accounts, describes a private schema,
executes, approves or polls. It receives the same `review_requested_if_available`
receipt on acceptance or denial; this is not confirmation that a queue item exists.
The stored private request is limited to one action per bound turn (one per live
voice delivery). Model-supplied identity, role and idempotency fields are rejected.

| Host | Required evidence |
| --- | --- |
| Customer Support website message | Signed, current visitor session/grant, ownership of the existing conversation, server-selected active agent matching its assignment. The workflow entrypoint forwards only a short-lived, message- and thread-bound signed assertion, not the visitor token. |
| Customer Support provider message | Actual service credential plus admitted Zavu inbound receipt (message, connection, sender, contact) or verified social-comment thread from the existing ingestion path. Conversation assignment must match the server-selected support agent. |
| Workspace chat, Sales, CMO and Customer Support message commands | Authenticated **non-service** principal with current site access who **owns** the DB conversation. Only the agent actually running that command and already assigned to the thread can request review. |
| Customer Support live Voice | Fresh v2 signature covering the tool name in the body; signed session ID must identify the exact independently verified live call. Signer, active local mapping of the provider agent, call sender, delivery and conversation assignment must agree. Opaque sessions do not qualify. Tool registration requires the normal voice sync at rollout. |

No first-turn thread is invented to obtain authority. Missing evidence, a delegated
role alone, unsigned/opaque provider identity, a generic internal caller, a replay
in another isolate, or a background/guidance/harness job grants no capability.
Agentbase attaches request authority to the in-process source command only, then
binds it to the exact persisted command during dispatch. Serialized tool schemas
are not capabilities. Other hosts must establish an independent conversation-
and agent-bound resolver before installing this adapter. None of these paths grants
channel execution after manager approval or sends a result back to a customer.
