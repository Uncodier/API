# Sandbox housekeeping and requirement retry containment

## Scope

This repair changes runtime classification and reporting, not accounting policy.
It does not alter balances, budgets, session watermarks, historical meters, or
provider resources. Deploy the API to activate it; no database migration is required.

## Requirement execution

- The exact registration rejection `Sandbox requires available credits`, or the
  exact `P0001` settlement rejection `Sandbox billing requires available credits`,
  becomes `insufficient_credits`. Other provider/SQL failures are not funding proof.
- Workspace admission preserves this distinction. The owned requirement runtime
  persists `paused` with `sandbox_credits_required` or
  `sandbox_reconciliation_required`, rather than repeatedly yielding `waiting`.
- Invalid monetary budgets pause with `requirement_budget_configuration_invalid`;
  unavailable budget evaluation pauses with `requirement_budget_evaluation_unavailable`.
  Neither becomes permission to spend. NULL remains unlimited; negative values
  are not converted to zero or NULL.
- Existing finish-cycle projection blocks these paused runs. Existing ownership,
  generation, user-pause and cleanup fences still apply. A failed state write does
  not establish a confirmed pause.
- Errors from provider resume, cancellation or ownership checks are not converted
  into accounting failures. Their normal authorization/transient/cancellation
  handling remains in effect.
- If the outer runtime cannot persist its final cycle outcome, it rejects rather
  than returning a successful `paused` receipt. The workflow step still has zero
  automatic retries, avoiding replay of a multi-effect slice.

These new reasons deliberately do **not** participate in automatic economic
recovery. The current sandbox RPC does not return a trusted recovery amount.
After sufficient funding, successful reconciliation, or an authorized budget
correction, use the existing authorized requirement resume flow. Do not clear
leases, reset generations, or resume all site work by directly editing rows.
Future automatic recovery must recheck settlement and all user/ownership guards;
`credits_available > 0` alone is insufficient.

## Housekeeping

The existing 15-minute job continues reconciling all non-retired meters. The
response and v3 completion log now include bounded aggregate counts:

- `fundingPending`: confirmed funding rejection;
- `missingResources`: tracked lookup returned a confirmed missing resource;
- `reconciliationPending`: remaining errors in tracked processing, including
  technical/cleanup failures not proven to be funding or resource absence;
- `sandboxesAlreadyStopped`: idle orphan handles already terminal, distinct from
  newly stopped handles.

`billingErrors` is preserved. Funding and historical disappearance still cause a
degraded receipt; this change does not manufacture a healthy monitor. Missing
resources with settled, durable deletion intent retain the existing retirement
path. An unproven 404 is never retired automatically.

The cron can still emit a settlement error once per cadence for unpaid usage.
This patch stops requirement execution retry loops, not historical reconciliation
polling. Durable per-resource backoff/audit queues and separation of observed
consumption from collection are follow-up migrations, not part of this repair.

## Validation after deployment

1. Observe affected runtime cycles transition to blocked/paused with the explicit
   reason; verify no further model/workspace admission for the same generation.
2. Inspect at least two existing housekeeping executions. Compare category counts
   and confirm historical/funding pending work remains visible.
3. Verify balances and terminal watermarks were not modified by classification.
4. Resolve invalid budgets from authorized evidence, never inferred defaults.
5. Audit historical meters individually; retain evidence and original ownership.

Do not invoke housekeeping as a diagnostic probe: it can stop/delete resources.
Provider inspection must use control-plane reads with resume disabled.

## Follow-up: insufficient-funding SQL expected result

The original runtime-only scope above remains historical context. This follow-up
**does require** the forward migration
`20261106104500_sandbox_insufficient_funding_outcome.sql`; it is prepared only and
**has not been applied live**. No live operations or balance changes are part of
this change.

Deploy the updated API **before** applying the SQL migration. The new caller
understands both the old exact P0001 funding rejection and the structured result
`success:false, outcome:'insufficient_credits'`. Older API instances would treat
that structured result as generic reconciliation pending. The read-only deployed
contract review confirmed that the five-argument `deduct_credits` returns the
exact `success:false, error:'Insufficient credits'` result used by this migration;
different overload errors are not caught as funding outcomes.

An internal, locally guarded sentinel rolls back the **entire RPC page/batch**
before returning insufficient funding. Earlier session deductions, ledger writes,
terminal markers, and watermarks within that batch are rolled back together.
This is **not** a transaction across the whole paginated provider history:
previously successful pages remain committed and idempotent. Any failed page
prevents full-history completion and does not authorize retirement. Technical,
identity, malformed-result, and downstream sentinel errors still propagate.

Expected funding pending remains unpaid and **degraded**, not successful
reconciliation: `fundingPending` and `billingErrors` remain visible, admission
stays blocked/paused, and the existing authorized recovery requirements still
apply. The migration removes expected PostgreSQL P0001 noise; it does not forgive
usage, replenish credits, introduce automatic recovery, or stop cadence polling.