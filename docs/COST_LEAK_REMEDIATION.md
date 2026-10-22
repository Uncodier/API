# Cost-leak remediation

## Scope and rollout boundary

This repair changes admission and resource lifecycle, not commercial tariffs.
One product credit remains USD 1; image pricing and the OpenRouter 25% markup
are unchanged. Tests are offline and do not read developer environment files,
run inference, or create/resume/delete provider resources.

Runtime corrections are not a production deployment. Apply the new forward
migrations to the **Makinari API database**, verify their service-only RPCs and
RLS permissions, and deploy the runtime together. Do not deploy reservation
callers before their database functions are available: admission fails closed.
Do not apply this repository's mixed-project migration directory wholesale.

New API migrations, in order:

1. `20261022000000_image_generation_credit_reservations.sql`.
2. `20261022000001_sandbox_lifecycle_evidence.sql`.

The image migration requires the shared Startup trial schema, credit writers,
and renewal contract managed by the application database, in addition to the
API's annual coverage migrations. It deliberately fails if trial schema is
missing rather than treating trial credits as purchased funds. Its offline
fixture is test-only, never a replacement production migration.

## Public image authorization

`Origin` and `Referer` are routing hints, not proof of authentication. An unsigned
platform-origin request may only retrieve an already-public cached image; a
cache miss must not start paid work. New generation requires an authenticated
principal authorized for the requested tenant or a valid prompt/dimensions/site
signature. System-funded generation requires a server-validated internal
service principal, not an ordinary user with a platform-origin header.

Authenticated/signed responses must not enter a shared CDN cache that would
bypass future authorization. Existing publicly deliverable cached artifacts
remain separate from paid generation admission.

## Paid effects and retries

Paid image generation is a non-retryable Workflow step. Its successful result
is durably returned before the independently retryable download/cache step.
Downloading or uploading again must never call the generator again. A provider
timeout or lost response is uncertain, not evidence that generation was free.

Internal image calls may send a bounded `Idempotency-Key` generated from Workflow
step metadata. The API binds it to the tenant and request fingerprint. Repeated
operations return 409 without another provider call. External callers cannot
choose this server identity. Missing hold/dispatch/settlement acknowledgements
do not authorize inference replay or release successful output without a charge.

Image credit admission must atomically reserve the existing tariff before
provider dispatch. A validation-only balance read is not a reservation. Holds
must preserve the trial/plan/legacy/purchased source buckets and their validity
periods. Never release a dispatched hold merely because the HTTP request timed
out; reconcile the provider outcome under the same operation identity.

## Sandbox reconciliation: historical 404s

Four meters returned provider `404` during the audit. Absence today cannot prove
that a VM was never created or used. Keep their audit history and pending status.
Do not mark a cron healthy by suppressing these errors or resetting their meter.

For each missing meter, an operator must:

1. Locate its server-resolved owner and registration timestamp.
2. Establish provider creation/session/deletion evidence using read-only control
   plane APIs and retained execution receipts. Do not run commands in a stopped
   VM as an inspection shortcut: convenience methods can resume paid compute.
3. Reconcile evidenced post-registration intervals. The rollout floor excludes
   earlier sessions; zero session rows alone does not establish underbilling.
4. Retire only with verified no-dispatch/rejection evidence or settled deletion
   intent. Unknown disappearance stays pending; never fabricate a refund.

Snapshots are restore points, not disposable logs. Do not delete paused user
work to make the inventory smaller. Cleanup should stop paid compute promptly
while preserving work and accounting evidence, and bound snapshot retention.

Harness cleanup uses a durable database claim for the current lease/resource.
Resume/claim/adoption must not race an in-flight stop. A confirmed stop releases
the claim; an unknown stop outcome preserves it. To recover an orphaned cleanup
claim, inspect the VM through control-plane APIs, confirm there is no active
provider session, reconcile billing, and only then finish the matching cleanup
token with the service-only RPC. Never clear a claim by a timer or user request.

## Azure BYOK and costs outside Vercel

OpenRouter can report zero account cost while Azure BYOK has positive upstream
expense. Standalone generation receipts preserve allowlisted accounting facts
separately; see `AGENT_SANDBOX_CREDIT_BILLING.md`. This does not recover historical
Azure spend or silently amend customer pricing. Reconcile provider invoices
before choosing a commercial BYOK tariff. Historical zero-cost receipts without
BYOK evidence remain unknown, not proof of free inference.

## Spend controls and recurring work

Vercel's analytics spending limit is not a team-wide circuit breaker. Confirm an
On-Demand Budget, notifications and optional Pause Production Deployments in
team billing settings. Pausing production is an availability decision and does
not necessarily remove storage charges. No global pause or arbitrary production
budget is activated by this repair.

Cron cadence and valid workflow retry budgets are product behavior. Reducing
them blindly may miss due work or grow queues. Prefer durable dispatch,
idempotency, ownership, total deadlines and bounded admission over dropping
scheduled work. Observability receipts are operational evidence; do not hide
failures or erase rapid failure/recovery transitions just to lower event counts.

Cron workflows now await durable queue acceptance instead of launching a detached
promise. Whole-run automatic retries are disabled; existing workflow execution
claims and explicit step retry budgets remain authoritative. This does not
introduce a new arbitrary concurrency or dollar limit.

JSON continuation accepts at most three legacy generation attempts and one
total timeout (up to 120 seconds), honors zero attempts, and propagates a parent
abort signal. A failed/uncertain provider request stops continuation and must not
fall through to another fallback inference. Successful malformed content may
receive bounded additional attempts within that same total budget.

## Offline validation

Verified with Node.js 22.22.2 and an empty provider environment:

- Billing: 29 suites / 352 tests passed, including three real multi-session
  PostgreSQL image reservation races on a disposable private Unix socket.
- AI/media: 68 suites / 1,050 tests passed, including the installed Workflow
  SDK step handler's actual retry behavior using an in-memory world.
- Portable harness: 45 suites / 413 tests passed.
- Cost guards: 3 suites / 18 tests passed.
- Cron observation/authentication: 77 tests passed.
- Legacy Sandbox lifecycle regressions: 31 tests passed.
- Full TypeScript check completed without diagnostics (`tsc --noEmit
  --incremental false`).
- Clean credential-free Next.js/Webpack build compiled successfully. Generated
  Workflow code retains `maxRetries = 0` on paid generation/whole-run steps and
  `maxRetries = 3` only on the cache step.
- The clean build passed its TypeScript stage, then stopped during page-data
  collection: the existing `/api/agents/sales/regionVenues` initializes a service
  requiring `GOOGLE_CLOUD_API_KEY`. No real or synthetic provider key was supplied
  to bypass this credential-free build boundary. This is not a successful
  end-to-end production build or deployment.

Some groups overlap; these numbers are not a count of unique assertions.
SQL fixtures are disposable, and no provider resource or invoice was modified.
Passing offline tests is not proof that migrations have been deployed or that
historical costs/404 resources are reconciled.