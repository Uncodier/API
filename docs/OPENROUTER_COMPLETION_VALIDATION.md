# Customer OpenRouter continuation validation

Local engineering continuation, 2026-11-12. This document supersedes the earlier
foundation-only checkpoint. Deployment and real provider acceptance remain
separate gates; no live-provider readiness is claimed from offline tests.

The subsequent [review repair pass](OPENROUTER_REVIEW_REPAIRS.md) corrects confirmed
coverage and recovery defects in this checkpoint; consult it before rollout.

## Implemented setup and policy changes

- Automatic recommendations use a server-built vendor-diverse catalog shortlist,
  an account-owned bootstrap model, structured outputs, no tools and no business
  prompts. The model output is untrusted and validated against the shortlist.
- Explicit one-time consent, a USD budget, prompt/output price ceilings, bounded
  input and output, no request-price endpoints, no provider fallback and no retry
  protect setup. Setup selection is advisory: price, names and recency are not
  treated as quality evidence. Unknown metadata is not invented.
- Manual and disabled routes survive recommendations and refresh. Automatic mode
  uses the saved recommendation only after an explicit policy change. Embedding
  models/dimensions are an exact existing-index contract, not automatic migration.
- A durable setup attempt precedes paid requests. Its UUID is single-use across
  retries/processes; one attempt/minute and a $5 maximum authorized daily setup
  total bound repeated IDs. Missing results remain dispatched/uncertain and require
  reconciliation. No setup action deducts platform inference credits.
- Account model discovery includes endpoints, pricing and output limits; explicit
  partial/paginated responses are rejected rather than interpreted as removals.
- Image verification uses a synthetic fixed prompt, one PNG, a fixed per-image
  price quote and the quoted provider tag. Token/megapixel/variant pricing is not
  guessed. Price quotes are not upstream hard spending guarantees; configure an
  OpenRouter account cap before live testing. Unknown or over-budget evidence
  cannot enable a capability.
- A successful image must match the model, decode fully, persist with tenant and
  setup links, and report cost. SQL verifies completed setup/credential/model/
  provider/artifact evidence before accepting `available`. Proof expires and
  credential rotation invalidates it. Normal runtime enforces the same endpoint.
- The private plan routing table is immutable, migration-backfilled for existing
  plans, and inaccessible to browser roles. New plans must be pinned before
  scheduling. Missing pins after storage enablement fail closed.

## Runtime and media continuation

- Command submission, processor phases, supervisor phases and registered Gear
  workflows preserve server-owned payer references in private durable storage.
  A dedicated durable-operation boundary makes immediate HTTP processing and
  later queue processing use the same dispatch namespace.
- Command HTTP entry points independently authenticate and scope admission before
  retaining their existing resource/role checks. Support visitor sessions remain
  a separate verified, site-bound identity path; a supplied user ID is not auth.
- Text, embeddings, continuation, summary, instance naming and site analysis
  endpoints restore signed server routing across HTTP. Signatures bind site,
  destination, expiry, operation and semantic capability; receivers still perform
  their own credential authorization.
- Assistant, delegated plans, bounded channel plans, maintenance and update-repo
  durable steps restore the original payer. Summary helpers select the policy
  summary model before budgeting and retain the existing embedding index space.
- Apps migration diagnosis/review inherit the owned workflow scope and reject
  unscoped execution during rollout. SQL authorization is unchanged. Dormant
  retired cron helper families are not reactivated as part of BYOK.
- Customer speech, transcription, images and video use dedicated adapters,
  bounded responses and private dispatch receipts. Global Azure/OpenRouter paths
  retain their prior model/provider setup and independent resource charges.
- Customer images persist validated PNG artifacts and receipt linkage before
  returning success. Video stores its immutable payer/job identity and accepted
  provider ID in PostgreSQL, with Redis only a recoverable status cache. Resume
  never submits another generation and never uses today's account selection.
  MP4 validation checks structural completeness, not codec decoder fidelity.

## Configuration and approvals

`OPENROUTER_CREDENTIAL_ENCRYPTION_KEY` remains server-only. No new credential is
stored in the browser or job payload. `OPENROUTER_ROUTING_STORAGE_READY=true`
is a schema deployment prerequisite, not consent to spend. **Keep it enabled
during admission rollback** so workers can still recover immutable customer
payer references. Turning storage reads off after customer execution exists is
not a supported rollback.

New admission additionally requires `CUSTOMER_OPENROUTER_ENABLED=true`. Neither
flag was set by this coding session. Database publication also requires an
unexpired `openrouter_rollout_approvals` entry created by the database owner;
service-role/API/customer requests have no approval write privilege. Each runtime
credential resolution rechecks that approval. Expiry blocks customer execution,
not a switch to platform funding. Approval must follow the live acceptance gate.

Schema changes are forward-only in the web repository. They have been tested
locally but not applied to the remote project:

- `20261112020000_openrouter_runtime_dispatch.sql`
- `20261112021000_openrouter_command_routing.sql`
- `20261112022000_openrouter_plan_routing.sql`
- `20261112030000_openrouter_setup.sql`
- `20261112040000_openrouter_pilot_approval.sql`
- `20261112050000_openrouter_dispatch_attribution.sql`
- `20261112060000_openrouter_customer_video_jobs.sql`

The original `20261112010000_openrouter_customer_connections.sql` is retained.
All deployment/schema changes and actual paid provider tests require separate
approval. No paid setup request has been executed by the coding session.

## Validation commands

API repository:

```sh
npm exec -- jest --config jest.openrouter-connection.config.js --runInBand
npm exec -- jest --config jest.ai.config.js --runInBand
npm exec -- jest --config jest.assistant-runtime.config.js --runInBand
NODE_OPTIONS=--experimental-vm-modules npm exec -- jest --config jest.assistant-runtime-esm.config.js --runInBand
npm exec -- jest --config jest.billing.config.js --runInBand
npm exec -- tsc --noEmit --incremental false
```

Web repository:

```sh
npm test -- --config jest.openrouter.config.cjs --runInBand
npm run typecheck
```

The local PostgreSQL suites exercise real SQL grants, concurrent dispatch/setup
claims, immutable references, same-tenant receipts and verification publication.
They use disposable socket-only databases and never read configured database URLs.

## Live acceptance still requires authorization

Confirm the target disposable site/account, allowed models/providers, hard account
spending cap and maximum total spend. Run one small text/tool request, a successful
image verification and selected media requests; inspect provider generation IDs,
customer receipts and zero platform inference holds/debits. Exercise disconnect,
credential rotation and resume without replay. Separately verify unchanged global
execution and independent VM/tool/channel charges. No passing offline test can
prove remote model availability, API grants or real invoice attribution.

## Recorded offline evidence

- Web setup/integration/billing regression: 31 suites / 707 tests passed.
- Dedicated web BYOK tests: 3 suites / 23 tests passed; targeted ESLint passed.
- API AI regression: 107 suites / 1,641 tests passed. The parent skips nine
  PGlite-only video SQL cases and executes them in a child with the required VM
  flag; direct video VM validation separately passed those nine cases.
- Assistant regression: 52 suites / 848 tests; ESM/compiler: 15 / 249 passed.
- API billing regression: 29 suites / 375 tests passed.
- Direct/legacy node executor regression: 44 tests passed, including no platform
  inference balance requirement within validated customer scope.
- Setup/private-plan/verification SQL and API regression: 9 suites / 72 tests
  passed; dispatch attribution PostgreSQL regression: 4 tests passed.
- Apps migration security and diagnostic regression: 75 and 48 tests passed.
- Command admission/durable workflow tests: 31 passed; command regression:
  146 passed; support regression: 254 passed; stand-up regression: 78 passed.
- Real Workflow compiler checks passed for assistant, maintenance and update-repo
  bundles with server-only routing/storage excluded from deterministic code.
- Web full typecheck passed. API full typecheck passed at the final integration
  checkpoints; final patch checks are recorded in the delivery summary.

Counts overlap between broad and focused runs and must not be summed as unique
coverage. Synthetic provider responses test contracts, not real account readiness.