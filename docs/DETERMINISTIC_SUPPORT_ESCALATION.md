# Deterministic support escalation

## Behavior

`escalate_support` is no longer a model tool decision. The agent-facing
`harness_decide` schema and backend parser accept only `approve_backlog` and
`adapt_backlog`. Rejected legacy/cast inputs cannot write or send support.
The migration reviewer cannot choose `platform_review`: malformed or missing
model verdicts request corrective output within the existing bounded loop.
Deterministic SQL/security/ownership failures still deny application.

Only the host circuit breaker can produce a new support ticket. It reloads
canonical requirement, plans, migration recovery and relevant operation events.
It requires outstanding technical work, exhausted recovery, no independent
executable work, and no pending repair/validation/retry. An arbitrary
`needs_review`, quarantine label, free-form reason, or model assertion of
impossibility is not exhaustion evidence. Unknown/truncated state fails closed.

An exhausted item does not stop independent work. Its dependencies remain
blocked; unrelated runnable backlog/plan work continues through the existing
scheduler. Explicit migration/security holds are not released by this policy.
The reporting agent cannot create tickets or claim an assigned human reviewer.

## Existing budgets, not new retry allowances

- Product self-heal stops reviewed product defects at its existing three-attempt
  boundary; the scheduler's configured per-tier limits still apply.
- Judge evidence/contract checks retain `JUDGE_VERIFICATION_MAX_ATTEMPTS`
  (default three). These are verification failures, not invented code repairs.
- Structured repair runs retain their host `max_attempts`. Proof requires
  uniquely attributed action receipts, current execution generation and a
  matching durable step-patch event. Test/validation preparation reads do not
  become repair attempts.
- Infrastructure circuits retain the existing four-failure boundary. Deployment
  waits with automatic recovery are not converted into support by the counter.
- No-progress keeps the existing three-cycle circuit and consumed adjudication,
  corroborated with its accepted cycle record. It is labeled no-progress, not
  successful repair execution.
- Migration recovery requires the existing five-call correction/review budget
  and settled independent diagnosis/follow-up. Five assignments/reviews are not
  described as five executed SQL repairs.

Changing strategy, updating a plan, or handing off to another agent does not
reset budgets. Model plan creation/update cannot manufacture or replace repair
state, no-progress adjudication, host execution identity or retry counters.
Unchanged persisted metadata may be echoed during a normal plan update.

## Persistence and rollout

Apply the migration documented in `HOST_SUPPORT_CIRCUIT_BREAKER_SQL.md` to the
Makinari requirement database **before deploying the API changes**. No customer
SQL, Apps schema, privilege expansion, or credential changes are involved.
Without the migration the new support payload is rejected, never silently
retried as a legacy ticket.

The support receipt stores the structured circuit-break proof, exhausted
targets/counters/receipt identifiers and complete plan/migration snapshots.
The SQL transaction rejects stale snapshots. The host rechecks eligibility
before email delivery. Replays preserve the original ticket and existing email
claim semantics; historical model-created tickets without proof are not adopted
as circuit-break receipts. Changed backlog revisions or recovery snapshots do
not authorize sending an old ticket. Report-only timestamp changes may replay.

Ticket persistence is not email delivery. `not_eligible` means this evaluation
did not authorize support; `unavailable` means eligibility/storage is unknown.
Neither unblocks work, resets attempts, or establishes product acceptance.

Deployment does not reopen already-blocked NEX work, restore its files, or
release legacy security holds. Those require the existing controlled recovery
or reconciliation path. New no-progress/infrastructure global blocks also
evaluate support after accepted cycle accounting, without another model turn.
Before settling an in-progress attempted step, the host requires confirmed
sandbox shutdown and the existing execution-generation/step CAS. Failed cleanup
does not establish that a worker stopped, and therefore cannot authorize that
settlement or a support ticket. Independent steps are never cancelled by it.

## Validation

The existing offline Jest harness includes policy, tool-surface, reviewer,
workflow, replay, secret-redaction and PGlite recording-contract regressions.
Tests exercise mocks/local PostgreSQL only; they do not claim a production
deployment, a real support email or an end-to-end NEX recovery.

Local validation at implementation: **191 suites / 2,969 tests passed** with
the complete offline harness. `git diff --check` passed. Repository-wide
`tsc --noEmit --incremental false` still reports two pre-existing diagnostics
in `migration-retirement-cli.test.ts` (lines 25–26), outside this change; none
were reported in the files changed for deterministic support.

Conservative inspection bounds: 50 explicit linked plans, 100 migration rows,
100 diagnostic rows and 1,000 step events. Overflow or unavailable historical
evidence preserves the hold without asserting that every recovery was exhausted.
Existing cost-only/total-cycle admission holds without a supported technical
exhaustion receipt also remain holds, not automatic support tickets. This change
does not fabricate repair attempts from monetary spend or total cycle counts.