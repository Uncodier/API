# System status: evidence, not an SLA

The `/status` page and `/api/status` show stored health observations. No public
read starts AI generation, runs a cron, sends a notification, or processes a webhook.
Current passive evidence is refreshed on reads with a 15-second cache; it no
longer waits for the hourly history snapshot. Historical percentages and
`lastRunAt` still refer to recorded monitor runs, not a fabricated new run.

## States and metrics

- `up`: the documented probe/receipt succeeded. A **contract** check is not an
  end-to-end test of the business operation.
- `down`: observed failure, unavailable required configuration, or a failed HTTP
  contract. Transport failures, status 0, redirects, 401/403, 404 and 429 never pass.
- `degraded`: observed degradation or incomplete monitoring coverage.
- `skipped`: unverified/not configured; it is neither a success nor an outage.

`metric: observed_check_success_rate` identifies the percentages. The legacy
`overallSla24h`, `slaBySystem` and `uptime*` JSON names remain for compatibility,
but these are successful **observed checks / observed checks**, not elapsed
availability or a contractual SLA. Overall 24-hour success is the mean of available
per-system rates. Windows with no observations are null, not 100% or 0%.
`observation` separately reports latest-run system coverage. Partial evidence with
no observed failure is excluded from success-rate denominators.

The 90-day chart uses actual 90-day counts, not 30-day percentages. Each bar shows
the worst observed state in that UTC day; one failed check does not make every
other successful check in that day a failure. Unknown/configuration-only legacy
observations are normalized at read time; historical rows are never rewritten.

`stale` becomes true when the hourly monitor's last run is older than 90 minutes
or has an invalid timestamp. A failed refresh can return the last cached snapshot
with `sourceUnavailable: true`; it cannot keep an overall green status. A history
load error is displayed as unavailable, not as an empty history.

## Deployment configuration

- Set `STATUS_PROBE_BASE_URL` to the intended deployment origin.
- Set `STATUS_PROBE_SITE_ID` to an operator-selected site's UUID for read-only
  public content/posts/RSS response checks. Without it, Public API is unverified;
  the monitor does not select a customer's site automatically. Use a dedicated
  monitoring site where practical. Public requests do not attach a service key.
- Keep `STATUS_AI_PROBE_ENABLED` absent/false unless explicitly opting into
  billable text inference. This repair does **not** enable it.
- Apply
  `supabase/migrations/20261020195500_status_observed_history.sql` through the normal
  migration process for compact daily/30-day aggregates. RPCs are service-role-only,
  security-invoker, and use an empty search path. If functions are not installed,
  the application falls back only for missing-function codes to fully paginated
  raw history. Other RPC errors propagate. The migration is not required for
  correctness but avoids fetching all raw rows for every cache refresh.

### History timeout repair

Apply `supabase/migrations/20261027020000_status_history_snapshots.sql` after
`20261020195500_status_observed_history.sql`, through the approved migration
process, before deploying the snapshot consumer. This forward migration adds
service-role-only, security-invoker JSONB snapshot RPCs for daily and 30-day
aggregates. It does not rewrite historical data or change normalization.

Each snapshot returns the complete ordered array in one scalar result, including
more than 500 groups, so PostgREST row caps do not truncate it. The application
does not paginate aggregates or make an extra empty-page aggregate call. Snapshot
requests have a seven-second abort deadline. Missing snapshot functions fall back
only for `PGRST202`/`42883` to raw history; permissions, timeouts and malformed
results never trigger fallback or fabricate empty history. Raw history uses fixed
time bounds, deterministic pagination and one shared 20-second abort deadline.

Daily results have a 60-second Redis cache and a bounded process-local copy;
summary cache remains 30 seconds. Daily refreshes require an owner-token Redis
lease shared between instances, with a 60-second expiry. Contenders wait at most
eight 250ms intervals (plus bounded Redis operations), then show history as
unavailable instead of starting another scan. Failed loads create a 30-second
shared/local retry cooldown, not a cached empty result. Failed result/cooldown
publication retains the lease until expiry instead of immediately admitting
another scan. Redis admission failure or missing configuration serves only an
unexpired local result; otherwise history is unavailable, preventing database
fan-out during a Redis outage. The existing page labels unavailable history.

This repair reduces duplicate computation; it does not precompute historical
states. A single snapshot still runs the existing JSON normalizer. After approved
rollout, check RPC request counts, latency and timeout logs before considering
persisted observed states or daily summaries. No timeout increase is required.

## Passive evidence

Text receipts are scoped to the resolved OpenRouter model and platform
credentials. Stream acceptance is not success: generated output and completed
iteration are required. Cancellation does not fabricate a success or provider
failure. Transcription receipts are scoped to the Azure deployment and platform
configuration; transcription never verifies TTS. These receipts expire after 15
minutes. No text probe verifies image, video, transcription or speech generation.

Text observations cover the actual harness, automation, API, workflow,
conversation, naming and analyzer calls. Retry sequences emit after final
completion, not after each admission attempt. No SDK transport is patched and
no additional request is issued by observation.

TTS emits after bounded nonempty audio validation. Images emit after validated
generation and persistence. Video emits successful completion after generation,
persistence and billing; pending submission is never a successful completion.
Notification insert results and provider email acceptance have independent
receipts. The transactional facade covers direct SendGrid/Zavu callers as well
as the central notification services. No recipients, sandbox sends or failed
validation create successful receipts; acceptance does not prove mailbox delivery.

Stripe, WhatsApp and AgentMail use independent 15-minute webhook receipt windows.
A public invalid signature is not a provider outage. Receipts attest to the
documented acceptance/processing stage, not downstream completion or email delivery.

All 12 scheduled business crons in `vercel.json` have independent, awaited
invocation/dispatch receipts. The status monitor excludes itself. Freshness:

| Schedule | Receipt freshness |
| --- | --- |
| Every minute | 3 minutes |
| Every 5 minutes | 15 minutes |
| Every 15 minutes | 45 minutes |
| Daily | 26 hours |

Disabled catalog indexing is explicitly exempt, not recorded as healthy execution.
Only repetitive authentication successes are sampled. Every business-operation
receipt and every failure/recovery transition is retained. Missing Redis sampling
no longer silently drops telemetry writes. Reads/writes have a three-second
deadline and do not publish raw provider/database errors. Strict required-capability gates
cannot pass unverified checks. Public status may stay degraded when coverage is
incomplete even though no observed operation is failing.

## Validation

Run `npm run test:status`. It runs isolated CommonJS health contracts and ESM cron
entry-point contracts; both avoid developer environment setup and live work.
The optional migration is executed against an in-memory PGlite fixture, including
normalization parity, counts over 1,000 records and role/permission assertions.
AI regression tests are also included in `npm run test:ai`.

An external uptime checker/alert receiver is still needed to detect the hosting
platform being entirely unreachable and notify operators. An application cannot
send an alert after its own runtime has stopped. The status page is evidence, not
an incident-management or paging service.