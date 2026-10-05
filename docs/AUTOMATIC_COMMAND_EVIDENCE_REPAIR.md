# Executable validation evidence recovery

## Incident and scope

Content Factory (`49a94f38-561a-4a2e-9e38-2563a2c2d164`) had four durable
applied migration receipts and a validated historical lifecycle when investigated.
Recent migration checks passed. The current Judge diagnostic was instead
`missing_command_receipt` for lint: its evidence-only worker could inspect files
but could not start the required validation command. Repeated inspection and
gate-only adjudication could never supply that proof.

This change repairs that recovery path. It does not introduce another migration
review, release historical holds, restore missing applied SQL automatically, or
resume the existing incident. Pending migration SQL retains the ordinary
implementation loop and immutable applied history.

## Contract

- Typed `missing_command_receipt` evidence gaps for lint/build/typecheck produce a
  host-bound `sandbox_run_validation` action. Free-form error text grants no tools.
- Only the exact existing npm/pnpm/yarn/bun validation script is selected. Bare
  script aliases use npm. No arbitrary command arguments, shell tool, detached
  process, download, fix flag or lifecycle hook is exposed in evidence collection.
- The host checks the existing script is a direct validator for that purpose and
  executes it with the SDK's server-side three-minute process timeout. This is
  bounded execution of repository tooling, not a semantic security proof of all
  dependencies or configuration loaded by a validator.
- Ownership and workspace identity are rechecked before execution and before
  canonical persistence. Only a completed, passing, unchanged-workspace receipt
  materializes the repair; independent gate/Judge approval remains mandatory.
- `commands` evidence is separate from `tests`. Lint/build cannot satisfy the
  automated-test obligation. Command matching is exact; `lint:fix` cannot prove
  `lint`. Current completed failures contradict success and stale receipts do not.
- Preparation reads do not consume command repair attempts. A real failed
  validator or unsupported/missing script transitions the same repair run to
  implementation, retaining its item, identity and consumed budget. Unknown
  process outcomes remain technical failures, not permission to edit SQL.
- An active bounded command recovery receives its normal executor turn rather
  than being starved by the no-progress gate-only shortcut. Exhaustion, overall
  execution limits, ownership, quarantine and terminal history remain intact.
- Applied-file history diagnostics explicitly request exact-byte restoration at
  the original path; they do not incorrectly recommend rewriting pending SQL or
  appending a migration to bypass missing history.

## Rollout

Deploy the API through the normal release process. This code change requires no
new database migration. Existing cancelled/blocked plans are not automatically
reopened and counters are not reset. Reconcile the current requirement through
its existing guarded recovery process after deployment; then verify a real lint
receipt followed by a fresh Judge verdict. A deployed preview or passing database
receipt alone is not completion evidence.

Offline tests use mocked sandbox/database boundaries and runtime-generated
synthetic sensitive values. They do not apply tenant SQL, execute a live model,
certify deployment or establish successful production recovery.