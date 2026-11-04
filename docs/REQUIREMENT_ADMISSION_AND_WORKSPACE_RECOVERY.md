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