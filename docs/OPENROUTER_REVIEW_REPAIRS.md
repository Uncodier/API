# OpenRouter BYOK review repairs

Repair pass: 2026-11-12. No paid calls, remote migrations, deployment or production
builds are authorized by this pass. Earlier completion claims do not override the
concrete review findings or the remaining live acceptance gate.

## Local loading failure after schema application

The web could not reach the configured API at localhost:3001. Starting the API
revealed a Workflow step-mode compiler failure: the WhatsApp `use step` file
re-exported its extracted lobby handler. Restore an async wrapper with the original
step identity instead of a re-export. A real step-mode compiler regression and the
existing Gear recovery tests cover this boundary. No production build is needed.

Initial OpenRouter loading errors now distinguish session failure (401), access
denial (403), unreachable backend, missing configuration and unexpected response.
They never echo raw provider errors or imply a missing owner role for every load
failure. The API must remain running alongside the web during local development.

## Audio caller/receiver contract

The audio tool consumes one host operation ordinal and hashes it into a bounded
`speech:<sha256>` identifier. It sends the same value in the signed routing ticket
and `Idempotency-Key`; the receiving audio route uses it for the durable dispatch.
Long workflow operation identifiers cannot exceed the HTTP contract's length
limit. Global calls retain existing Azure configuration and billing. Tool schema
provider/format options reflect the selected customer scope rather than forcing
an Azure-only hint on customer speech.

Regression: `customer-audio-tool-route.test.ts` sends the real tool request to the
real route and customer adapter, replacing only network/storage boundaries. It
asserts matching identifiers, customer credentials and zero platform credit calls.

## Combined chat capabilities

Independent models for tools, structured output and vision no longer need equal
IDs. The primary route is semantic summary, otherwise vision, tools, structured
output, then text. Its model must support the complete requested protocol and all
requested capabilities must remain enabled. Dispatch validates one current
credential/catalog snapshot, applies that model's context limits and does not
fall back to another model or account.

Configuration rejects incompatible primary/secondary combinations with an
actionable error. Recommendation shortlists exclude incompatible combined tool
and vision choices. Manual pins are not silently changed. Older policy snapshots
are checked again at dispatch and fail closed when incompatible.

Regressions: `chat-contract.test.ts`, `customer-routing.test.ts`, and the existing
selector/management suites.

## Recovering completed image verification

The manager-only `recover_verification` operation applies an existing completed
setup receipt against the latest configuration revision. It cannot generate an
image, decrypt a credential or incur another inference charge. It verifies the
site, connection, credential revision, current image model and original proof
expiry; expired, changed or uncertain evidence cannot enable images. The existing
SQL proof trigger remains authoritative. A concurrent configuration conflict can
be retried through this operation without repeating the paid probe.

The integration's setup status includes **Apply saved verification (no
generation)** for completed verification attempts. This action remains distinct
from explicit consent for a new paid verification.

Regressions: `recover-verification.test.ts` and web `openrouter-setup-ui.test.tsx`.

## Supervisor, image admission and plan creation

The supervisor validates the real principal and command-site authorization before
loading command contents or restoring its customer payer. Explicit and fallback
conversation IDs must belong to the same site. Missing credentials and cross-site
requests do not initialize or execute the supervisor.

Public prompt images now use rollout-aware admission: without enabled BYOK they
do not query customer tables. Existing authorized customer jobs still restore
their durable pin; closing new admission does not reassign accepted jobs.

Legacy plan writers now stage rows as blocked, persist an authoritative private
pin, then publish runnable state. SQL requirement-plan creation preserves its
original lease/generation checks and pins inside the same transaction. The old
signature remains explicitly platform-funded for new legacy calls; updates keep
the existing immutable pin. Public payloads cannot supply payer metadata.

Forward migration (API repository):
`supabase/migrations/20261112071000_requirement_plan_private_routing.sql`.
It depends on the shared `20261112022000_openrouter_plan_routing.sql` migration.

## Video recovery and concurrency

- The exact receipt RPC payload is checkpointed before delivery. Recovery resends
  that snapshot instead of polling for different cost evidence. Later provider
  evidence needs separate reconciliation, not mutation of the settled receipt.
- Forward migration `20261112072000_openrouter_customer_video_durability.sql` in
  the web repository adds compare-and-swap revisions and monotonic checkpoints.
  It accepts identical lost-acknowledgement retries but rejects stale overwrites
  and removal/replacement of persisted artifacts or settlement evidence.
- The dispatch UUID identifies both the asset primary key and object path. Upload,
  insertion and job-checkpoint failures recover the same stored artifact; retries
  cannot create random duplicate assets or overwrite different bytes.
- Authenticated terminal status reads and receipt-only retries do not decrypt or
  revalidate the original provider key. Requests requiring provider polling or
  download still validate the pinned connection and cannot fall back globally.
- MP4 validation now requires usable AVC configuration and sample/timing/chunk
  tables with bounded media ranges. It is a conservative nonfragmented AVC
  structural validator, not a full codec decoder or live playback guarantee.

SQL regressions use isolated databases, including overlapping independent
transactions, lost acknowledgements and stale-version attempts. No migration in
this repair pass was applied remotely, and no live image/audio/video request ran.

## Validation evidence

- API AI regression: 109 suites, 1,670 tests passed. Nine original video SQL
  cases are skipped in the parent runner and executed by its VM-enabled child.
- Connection/setup/authorization/plan regressions: 17 suites, 118 tests passed.
- Assistant regression: 52 suites, 848 tests passed; ESM/compiler: 15 suites,
  251 tests passed.
- Platform billing regression: 29 suites, 375 tests passed.
- Web integration/setup/billing selection: 29 suites, 678 tests passed.
- Dedicated web BYOK suite: 24 tests passed. The real PostgreSQL video durability
  suite passes nine cases, including independent overlapping transactions.
- Full API and web TypeScript checks passed; targeted web ESLint and both working
  tree whitespace checks passed. No production build was run.

Counts overlap between suites. Offline transport responses and disposable SQL
prove the exercised contracts, not live provider availability or customer billing
on an actual account. Keep activation gated until the approved live acceptance.