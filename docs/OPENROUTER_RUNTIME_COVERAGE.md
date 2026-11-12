# Customer OpenRouter runtime coverage

Local implementation inventory, 2026-11-12. This is not deployment or paid-provider
verification evidence. The connection activation gate remains closed until every
required execution boundary is covered. Do not enable selection by changing only
the UI or an environment flag.

The pending items below are the first-pass audit baseline. The continuation adds
durable dispatch, private command/plan pins, signed HTTP scopes and semantic
summary support. Track current code and [completion validation](OPENROUTER_COMPLETION_VALIDATION.md)
instead of interpreting this baseline as the latest implemented scope.

## Trust and accounting contract

`src/lib/services/ai/customer-routing.ts` owns the host-only routing reference:
site, payer, connection ID, policy version and credential version. It never carries
plaintext credentials, prompts, or arbitrary request fields. `resolveExecutionRouting`
must run only after site execution authorization. It queries connection storage;
storage errors must not become "no connection". Before schema deployment, admission
must retain the existing global path while the hard activation gate is closed.

`withExecutionRouting` restores a host-owned reference around an actual execution
step, validates current connection status/version, and prevents child payer/site
changes. Async-local scope is **not** durable propagation and does not cross HTTP,
workflow, queue, process or cron boundaries. Those boundaries must persist and
restore the reference explicitly. Existing customer references must never be
converted to platform references during rollback, disconnect or rotation.

The shared OpenRouter client creates its customer credential only at dispatch.
Each request rechecks the pinned policy and active credential. Customer requests:

- Use the selected policy model, not arbitrary caller/model overrides.
- Require current catalog membership and a conservative actual-model context bound.
- Require the same model for combined tools/structured/vision requirements.
- Disable provider fallback and SDK retries; uncertain outcomes are not replayed.
- Reject explicit credential overrides and unsupported SDK endpoints.
- Never inherit environment credentials, including a global client created outside
  the customer scope and subsequently used inside it.
- Exclude customer success/failure from platform provider-health observations.

`customer-inference-receipts.ts` writes the service-only
`openrouter_customer_receipt` RPC, not platform credit accounting. Fixed table
constraints require customer payer and zero platform charge. Evidence includes
connection/policy/key versions, host UUID, generation ID, requested/actual model,
provider, token counts, gateway/upstream costs and known/uncertain status. Missing
cost remains null/uncertain. Receipts contain no prompt, credential or raw provider
error. Receipt failure is terminal and never authorizes another generation.

`chargeOpenRouterUsage` skips platform billing only after an in-memory proof of the
customer dispatch receipt, not a caller payer flag, `usage.is_byok`, or zero cost.
Requirement billing retains execution ownership/cancellation validation but does
not reserve, dispatch, cancel or settle platform monetary holds under customer
scope. Bounded-channel inference admission skips its platform balance check only
under that scope. General `CreditService` is deliberately unchanged: VM, tools,
channels, search and other paid resources keep independent billing.

## Direct dispatch inventory

All paths below were found by source searches for client construction, credential
environment references and inference billing. Coverage of the shared client is
conditional on a correctly restored customer scope. It does not prove that every
entrypoint establishes that scope.

| Source | Global behavior | Customer runtime status / remaining boundary |
| --- | --- | --- |
| `lib/custom-automation/ai-agent-executor.ts` | OpenRouter, global models and existing settlement | Shared client covers non-streaming/streaming turns and nested helpers in scope; real executor offline test added. Existing 1,942-line file unchanged. Host budget still initially uses its supplied model; final dispatch enforces selected-model bound. |
| `lib/agentbase/services/PortkeyConnector.ts` | OpenRouter despite historical class name; separate charge path | Shared client/receipt handles scoped calls and stream settlement. Factories passing an explicit global `apiKey` fail closed in customer scope; legacy command admission/resume propagation remains incomplete. |
| `lib/agentbase/services/{SupervisorService,processor/ProcessorConfigurationService,processor/ProcessorFactory}.ts` | Explicit environment key passed into connector | Not migrated; explicit override rejected under customer scope. Must remove global credential injection only when trusted customer reference is propagated. |
| `lib/services/workflow-robot/bounded-channel-model.ts` | OpenRouter, platform balance gate and canonical usage charge | Scoped gate exemption and receipt-based settlement implemented. Durable channel runner must persist/restore payer at every scheduled attempt before activation. |
| `app/api/cron/shared/visual-critic-client.ts` | OpenRouter vision via shared client | Scoped client covers dispatch; cron ownership and pinned ref restore must be proven. |
| `lib/services/robot-instance/instance-naming.ts` | Shared OpenRouter client; local deterministic fallback | Scoped inference is customer-funded and receipted. Missing/error response may use local naming fallback, never another credential. Entry scope must precede helper. |
| `lib/services/robot-instance/InstanceContextManager.ts` | Executor summary plus embeddings | Scope reaches nested client; global-key existence precondition in compaction remains a blocker for customer-only configuration. Embedding-space compatibility must remain pinned. |
| `lib/utils/api-utils.ts` | Shared client | Only safe in restored scope; arbitrary API callers do not establish it. |
| `app/api/conversation/core.ts` | Shared client | HTTP/continuation ownership and pinned ref not yet covered end-to-end. |
| `app/api/workflow/execute-node/route.ts` | Shared client | Workflow entry/resume propagation not complete. |
| `app/api/ai/route.ts`, `app/api/ai/text/route.ts` | Shared client, current authentication/rate-limit behavior | Generic endpoints do not select a customer connection. No client payer flag is accepted as exemption; site-authenticated routing still required. |
| `lib/status/handlers/ai/provider-probes.ts` | Operator/platform probes | Must remain platform-only; not customer execution admission. No live probes ran. |
| `lib/services/embeddings-service.ts`, `app/api/ai/embeddings/route.ts` | Shared OpenRouter embedding client | Dedicated customer adapter owned by media teammate; ordinary SDK embedding endpoint is blocked inside customer chat wrapper. Index model/dimension compatibility is mandatory. |
| `lib/services/ai/{tts-service,transcribeAudio}.ts`, image services and `/api/ai/{image,audio}` | Azure direct | Dedicated adapter/guard work owned by media teammate; no global migration. Images must remain unavailable until an actual connection-specific successful generation is approved and verified. |
| `app/api/ai/video/{provider-openrouter,openrouter-jobs,route}.ts`, public video steps | Global OpenRouter video jobs, resource/credit lifecycle | Dedicated customer adapter/guard work owned by media teammate. Persisted submit/poll/download ownership and payer must be proven before enabling. |
| `lib/services/search/web-search.ts` | Direct Azure grounded search | Explicitly unsupported in customer scope; configuration guard fails before credential dispatch. Separate resource billing is not waived. |

Media teammate files/tests are authoritative for the evolving media adapter status;
this inventory does not claim that standalone helpers constitute HTTP/job coverage.

## Admission, persistence and secondary work inventory

- Assistant route: authenticates and authorizes the site, preserves global credit
  admission while rollout is closed, and supports payer-aware admission with
  durable options, context preparation, turn wrappers and recovery propagation.
  See [assistant checkpoint](OPENROUTER_ASSISTANT_ROUTING.md) for exact coverage.
- Assistant requirement billing: `requirement-billing.ts` has the scoped no-hold
  branch. Requirement claim/lease/pause/active-run checks remain independent.
- Assistant workflow, silent continuation, recovery snapshots, node execution,
  delegated plans, requirement cron, maintenance cron and single-turn execution
  must all carry the pinned host reference. No secrets belong in job payloads.
- Legacy commands, supervisor jobs, target processing, content/copywriter,
  customer support, chat, lead research, UX, update-repo and tooling routes call
  shared executor/connector transitively. Their separate request/queue boundaries
  are **not blanket-covered** by client interception. Activation stays blocked.
- Internal HTTP tools require explicit trusted propagation and receiving-route
  validation. A parent async-local scope does not propagate through fetch. Never
  forward an arbitrary client-provided payer/connection header as authority.
- Search/region-venues/Finder gates, sandbox/VM billing, outbound channel fees,
  procurement and resource entitlements remain unchanged. Customer inference does
  not fund these resources. Audio tools/channel preparations may still perform
  independent upfront checks until their dedicated adapters integrate admission.
- `harness/profile.ts` and `harness/requirement-profile.ts` credential references
  are sandbox secret-denial filters, not model dispatch; preserve those filters.
- Example code and documentation are not execution coverage. `composioTools` and
  tool evaluator credential references are not authorization to inherit customer
  secrets into tools or external integrations.

## Explicit rollout blockers

### Durable dispatch and HTTP update

The command HTTP admission pass covers the live submitter inventory: copywriter
content-calendar/editor/improve; chat/message; sales leadSelection/message/
leadResearch; growth campaign requirements; CMO dailyStandUp sales/wrapUp/growth/
system/support, message and stakeholder-coordination; dataAnalyst analysis/
leadSegmentation/leadContactGeneration/companyContactGeneration; email;
customerSupport/message; and integrations/whatsapp/agent. The support generator
and stakeholder agent service inherit their authenticated parent route scope.
These correspond to the 23 direct submitter files (21 route modules plus two
service modules), with the support parent as an additional receiving boundary.

`withAuthorizedCommandRequest` validates real credentials/site membership and
enters routing before the unchanged handler-specific validation and resource
checks. It limits request bodies to 1 MiB. Support also accepts cryptographically
verified visitor sessions; its existing session/grant/conversation checks remain.
WhatsApp derives the site from persisted conversation metadata and verifies that
the message belongs to that conversation, never a caller-supplied payer.
Oversized route context/persistence helpers and tool schemas were extracted into
bounded files without replacing their backend behavior.

Maintenance (still operationally paused) and update-repo now carry immutable host
references through workflow inputs and independently restore them in each agent
and visual-probe step. Initial, repair and probe passes have distinct durable
operation identities. The real Workflow compiler excludes routing/storage from
both deterministic workflow bundles; maintenance prompt construction is now a
step because its backlog dependency imports storage. Canonical assistant turns,
bounded-channel plan steps and command phases explicitly reset the operation
namespace when entering a distinct durable actor, not when nesting the same one.

The old `cron-execute-steps-phase` family (single-turn/orchestrator/cycle-wrap-up/
sync-docs/migration helpers) has no live route/workflow caller in this inventory.
It is not resurrected or claimed as an enabled BYOK path. The live requirements
cron invokes `runCronAppsWorkflow -> executeRequirementCycle -> runRequirementCycle`
and restores the immutable canonical assistant session. If retired helpers are
reactivated, their host routing boundary must be implemented first.

Additional offline evidence: command regressions 15 suites / 146 tests; support
19 / 254; daily standup 4 / 78; new command/workflow routing 2 / 31; maintenance
workflow/probes 2 / 4; real compiler 1 / 3. Full API typecheck passed after these
changes. No production build, paid call or remote migration was performed.

The shared chat/media contract now persists `openrouter_customer_dispatch` before
network dispatch. The forward `20261112020000_openrouter_runtime_dispatch.sql`
migration uniquely claims `(site_id, operation_key)`; stale and completed claims
never become dispatchable again. Receipt insertion settles the matching intent in
the same transaction. Confirmed pre-dispatch rejection closes the intent without
inventing zero-cost usage. Unknown outcomes remain operator-reconcilable through
service-only list/reconcile RPCs with append-only resolution evidence. A missing
generation ID after process loss is not permission to retry.

Host durable boundaries use `withCustomerOperation` to reproduce operation keys
on replay. Random one-shot event identifiers are not a substitute for these pins.
`customer-routing-http.ts` carries HMAC-authenticated short-lived references bound
to site, destination path and operation ID. Receivers authenticate the credential
and current site access independently, then restore the pin and operation scope.
Neither client payer flags nor middleware metadata confer authority. Disabled
rollout leaves unpinned platform requests independent of the new schema.

Semantic summary intent has an explicit `withCustomerCapability('summary', ...)`
scope. Chat budgets enforce the selected model context/output limits and combined
vision/tools/structured requirements. Image dispatch additionally checks current
credential/model/adapter/expiry and the verified provider tag.

Offline evidence for this increment: four core suites / 28 tests passed, including
actual disposable socket-only PostgreSQL concurrent transactions, stale claim
replay, atomic receipt settlement, ACL/tenant/version denial and reconciliation.
Four legacy global/tool regression suites / 60 tests also passed. The full suite
is rerun by the coordinating task after the remaining boundary/media work lands;
these counts do not claim complete rollout readiness.

1. Complete and test every actor/queue/HTTP/resume boundary, not just shared client.
2. Ensure every durable actor supplies a stable operation namespace to the new
   dispatch intent/reconciliation contract; never replay uncertain accepted work.
3. Complete legacy command/global-key injection migration under trusted scope.
4. Complete media protocol, image live-verification gate, durable video ownership
   and embedding-space migration safeguards. No paid verification is authorized.
5. Replace global-key-dependent compaction preflight and prove summary policy and
   context-budget binding. Current automatic text helper capability selection does
   not identify semantic summaries separately; summary policy is not fully wired.
6. Full runtime/SQL concurrency validation, deployment of approved forward schema,
   then explicit rollout approval. No migration was applied remotely.

## Offline evidence

- Initial post-client AI regression: 90 suites / 1,495 tests passed. This includes
  existing audio changes; no unrelated edits were reverted.
- Customer routing regression subsequently expanded to cover real main executor,
  auxiliary calls, nested scopes, cross-site denial, empty/revoked key, unsupported
  methods, receipt failure, no replay, uncertain SSE and selected-model budget.
- Existing requirement billing regression: 30 tests passed, confirming unchanged
  platform holds and uncertain-settlement behavior.
- Final AI checkpoint: 92 suites / 1,521 tests passed. Billing: 29 suites / 375
  tests passed. Assistant: 50 suites / 840 tests; ESM/compiler: 15 / 249 passed.
- Full API `tsc --noEmit --incremental false` passed. No production builds or live
  provider calls were performed; interrupted duplicate checks are not evidence.