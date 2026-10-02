# Recover migration coordination without weakening SQL checks

## Missing plan is not a security finding

The Apps workflow no longer creates a permanent `platform_review` merely because
an outstanding migration has no requirement-bound plan. After looking for both
an active plan and the completed source plan, it uses the existing bounded
orchestrator to recover a plan. The host restricts that invocation to source
readers, read-only harness inspection and `instance_plan` list/create. It removes
the general tools router, SQL, shell, file writes, status tools and escalation.
Plan creation is pinned to the host requirement/instance/site/user, and steps
receive `requires_sandbox=true`.

This recovery skips stale-backlog escalation but retains normal host WIP
activation for eligible pending work, so the recovered plan passes the next
cycle's active-item gate. It does not reset attempts, release quarantine, mutate
acceptance or execute product steps. Model-authored migration/repair receipt
metadata is stripped before creating the plan. It returns a handoff; the
next normal worker assigns correction or performs pending validation first. If
no plan is persisted, or sandbox provisioning fails while recovering the plan,
the workflow retains a retry under the existing scheduler/re-plan limits, not a
new migration-security hold. Missing plans cannot reach commit or final delivery.
The existing scheduler/backlog/ownership/pause gates remain authoritative.

For a completed product item with only migration validation outstanding, the
host preflight rechecks the persisted migration states and permits validation
only. Blockers, quarantine and infrastructure circuits still deny admission.
After validation the cycle exits without executing the recovered product step or
reopening the completed item. Ordinary implementation gates still reject done
items.

## Idempotent correction assignment

New correction assignments record a sorted binding of file, SQL checksum,
specification checksum and lifecycle version on the source step. A pending or
in-progress assignment with that same binding survives a new cron run without
another assignment attempt or replacing its instructions. Database row/key order
does not affect matching. A new lifecycle review/version, checksum, specification,
or file set invalidates the binding. Assignment event IDs also distinguish those
revisions, even when reviewed SQL bytes stay the same in one run.

For these new bindings, reuse additionally requires the existing service-only
atomic step-patch receipt. Its event ID binds the requirement, plan, step,
instructions, role/skill, backlog item and lifecycle binding. Model-authored
metadata alone cannot skip the diagnostic allowance at an exhausted budget;
unavailable receipt persistence fails closed.

Binding metadata alone is not trusted: reuse also checks a service-only atomic
plan-patch event whose ID hashes the exact requirement/plan/step, assigned
instructions, skill, role, backlog item and post-transition lifecycle binding.
Missing receipts enter the normal assignment/diagnostic path; unavailable
persistence fails closed. Appended corrections also receive that patch receipt.

The scheduler prefers an existing bound correction instead of an unrelated
trailing step. If only its sandbox flag is missing, it patches just that flag
through the existing generation-checked RPC. It does not clear infrastructure
circuits or claim the sandbox is healthy. Unstarted legacy assignments retain
their existing compatibility path. Historical attempt counts are not reset or
reinterpreted; distinct assignments/reviews still use the existing budget and
independent diagnostic allowance.

## Interpret inspection accurately

- `sandbox_tools_exposed` describes **this invocation**, not every worker. Chat,
  planning or restricted diagnosis may legitimately have no `sandbox_*` tools.
- A required sandbox flag is a provisioning request, not evidence of health.
  Confirm dispatch/provisioning failures from worker events before escalating.
- A missing-plan hold is not evidence that SQL was sensitive or already applied.
  Only the authoritative Apps migration receipt establishes application. Restore
  an applied file only from verified original bytes; use a new forward migration
  for subsequent changes. Do not infer application from a filename or prose.

## Deployment and existing incidents

This change requires an API deployment, not a new database migration. Existing
lifecycle, plan mutation and ownership RPCs must already be installed. It does
**not** backfill or automatically release historical `platform_review` rows,
rebind an old specification, or resume customer workers. Use the guarded
[operator reconciliation procedure](MIGRATION_OPERATOR_RECONCILIATION.md) for
eligible historical missing-plan holds and verify fresh ledger/workspace facts.
Do not manually UPDATE a hold away.

Security review, immutable applied checksums, RLS constraints, SQL receipts,
fresh product validation and delivery guards remain unchanged. A real security
hold, interrupted review, unknown write outcome or failed validation is not
converted into automatic approval by this recovery.

## Offline checks

From `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`, run `npm run test:harness`.
Regression coverage exercises the real workflow and orchestrator with isolated
I/O, restricted plan tool dispatch, lifecycle-bound assignment reuse, generation
checks, retry accounting and truthful invocation-local diagnostics. These tests
do not certify deployment, live sandbox health or application migration success.

Validation checkpoint (Node 22): **165 harness suites / 2,365 tests passed**,
including the [directory artifact evidence fix](DIRECTORY_ARTIFACT_EVIDENCE.md).
Next webpack compile-mode build completed with existing dependency/deprecation
warnings. Focused TypeScript checking of all 25 changed TypeScript files reported
zero diagnostics. The repository-wide TypeScript check still reports unrelated errors;
Next is already configured to skip type checking, so build success is not a clean
repository-wide type check. No database deployment, customer migration, support
delivery or worker resume was performed.