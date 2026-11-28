# Requirement admission and missing-workspace recovery

## Admission

Requirement cron admission excludes archived sites and sites without a positive
available credit balance. This is admission filtering, not cancellation: existing
requirement status, user holds and ownership remain authoritative. Recharging a
site makes its otherwise eligible work discoverable again on a later cron tick.
Missing billing records do not count as available credits.

The predicate uses persisted `billing.credits_available`; it does not renew plans
or debit credits while scanning candidates. Scheduled plan renewal/recharge must
update that balance through the existing billing path before zero-balance work
becomes eligible again.

Deploy `20261104110000_requirement_site_credit_admission.sql` for these filters to
affect the live scheduler. Application code alone cannot change database admission.
Deploy `20261104111000_missing_requirement_workspace_recovery.sql` before the
recovery runtime; it provides the service-only, lease/version-fenced reference
retirement operation. Without its receipt no billed replacement is created.

## Missing requirement sandbox

The runtime first tries the saved requirement sandbox. Only a structured HTTP 404
from that lookup produces `WORKSPACE_NOT_FOUND` and authorizes reprovisioning.
Authorization failures, provider billing failures, timeouts, 429/5xx responses,
ownership mismatches and an existing sandbox without a snapshot do not authorize
replacement.

Reprovisioning uses the same session, repository authorization, billing checks,
runtime environment, isolation and normal Git bootstrap. The replacement uses the
session-scoped `h-<session-id>` identity, so a later attempt can discover it after an
interrupted bootstrap. Existing resources are never deleted or reset. Creation
failures are not automatically replayed within the same attempt.

Before replacement, the owning host retires the confirmed-missing workspace
reference with a lease-checked session save. Transcript and other session state
remain intact and historical status retains the old resource ID. This permits the
existing bootstrap cleanup fence to stop a newly created VM if setup fails.

After bootstrap the runtime selects the requirement work branch, preferring its
remote branch when present, and records the new workspace reference. The model
receives a recovery notice before continuing. Remotely persisted source is
recoverable; uncommitted/unpushed files and old OS processes from a missing VM are
not. No successful preview, build or deployment is implied by recovery.

This change does not resume sessions paused for
`assistant_execution_requires_reconciliation`, clear uncertain operations, alter
the assistant execution boundary, or deploy application code to Vercel.

## Diagnosing a slow scheduler tick

The authenticated `/api/cron/requirements-apps` handler enriches its existing
`cron_requirements-apps` receipt in `system_telemetry`. No per-claim log rows,
new table, cleanup job or client reporting endpoint are needed. For operators
with existing telemetry access:

```sql
SELECT created_at, status, latency_ms, message
FROM public.system_telemetry
WHERE system_key = 'cron_requirements-apps'
  AND created_at >= now() - interval '24 hours'
ORDER BY created_at DESC LIMIT 100;
```

New messages are version-1 JSON; older receipts are plain text. `ms` contains
per-tick **sums**, not per-claim percentiles. `claim` includes the database
round trip. Its `economic_pause` (economic-pause recheck), `pending_commands`
(command drain), and `reservation` (capacity, candidate selection and lease)
measure elapsed time inside the same transaction. They are not additional time
on top of `claim`. `scheduled`, `dispatch`, `finish` and `cloud_git` measure the
route stages; Cloud Git overlaps admission. Omitted durations were not observed,
whereas zero is a measured duration rounded to milliseconds.

`stop` distinguishes `empty` (no further candidate), `capacity_full`, `limit`,
`deadline` and `error`. `claimed` counts reservations, `dispatch_failed` counts
rejected dispatch attempts, and `measured_claims` counts complete sets of SQL
timings (including empty and full results). An empty/full tick is `up`, a
handled dispatch rejection is `degraded`, and a scheduler 503 is `down`.
These are invocation results, not proof of downstream workflow or Git success.

One receipt per completed authorized invocation; at most 100 claims attempted,
eight allowlisted timing keys, and each stage total saturates at 60,000 ms.
No IDs, credentials, query text, error bodies, workflow inputs or request
headers enter the receipt. Its existing best-effort write has a three-second
timeout and runs outside admission. Missing receipts are not successful ticks.

The forward migration `20261128040000_requirement_claim_stage_timings.sql`
adds a service-caller opt-in to the existing RPC; its arguments, grants, locks
and validation are unchanged. Old callers still get the original result. A new
API with an older database still claims once and reports only route timings.
A failed/cancelled RPC cannot return its internal measurements. Earlier successful
calls in the tick still count; `failed_stage: "claim"` refers to the **whole**
RPC, not a guessed SQL stage. When available, `claim_failure` is `timeout`,
`contention`, `rpc_unavailable` or `request_failed`. A transport failure does not
prove rollback; the API does not retry a claim to obtain telemetry. A hard process
timeout can prevent even the outer receipt. No historical backfill is performed.
