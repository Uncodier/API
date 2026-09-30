# NEX / Content Factory diagnosis and automatic test repair

## Verified production diagnosis (read-only)

- NEX CARGO instance `dc06757e-5570-485c-9948-cf5bb9179ae8`, requirement
  `5a1d6caa-92a4-420d-80f2-567392a1af11`: the September 30 04:34 UTC
  migration gate rejected modified `supabase/migrations/0001_initial_schema.sql`.
  The prior agent checked out its creation commit, which was not the version
  recorded in the protected migration ledger. This fails before security review;
  no migration lifecycle row is expected for that failure.
- Apps records NEX migrations `0001`, `0002`, and `0003_bids_backend_intake.sql`
  as applied. Never reapply changed versions or edit the recorded checksums.
  The exact `0001` source is already retained at
  `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/tenant-migrations/app_5a1d6caa92a4420d80f25673/0001_initial_schema.sql`.
  Its SHA-256 is `ca06fbaed6510fc4eb2006d6e6d7838bcbebb1a7a61ad312a7de8db167743a90`,
  matching the live receipt. Restore that exact source into the product repository
  and sandbox through the normal controlled repair path, then use a new migration
  for further schema changes. This task does not perform that restoration.
- Content Factory instance `49a94f38-561a-4a2e-9e38-2563a2c2d164`, requirement
  `e914ffef-ea9b-4bf1-8a50-280418da46f2`: migrations were applied; the last lifecycle
  row became `validated` at September 30 03:21 UTC. At 07:18 UTC the Judge rejected
  missing passing test evidence. It generated an evidence-only/read-only repair,
  preventing test creation/execution, and exhausted evidence attempts. The 07:19
  wrap-up incorrectly asked the customer for permission to add Jest tests.

## Changes

- Missing automated-test evidence now produces the typed `missing_test_evidence`
  diagnostic and a `repair_tests` action in the same backlog item.
- The executor can inspect and edit tests and invoke `sandbox_run_tests`. Ordinary
  shell/background tools, status changes, direct migration tools and checkpoints
  are not exposed for this action. Existing unrelated evidence-only repairs remain
  read-only. A free-form message cannot unlock test-repair tools.
- The host runs the existing repository test command with a three-minute timeout,
  verifies the workspace fingerprint before/after (including test files), and
  persists canonical test evidence. Only a fresh typed passing receipt materializes
  the action. Fresh independent gate/Judge validation is still required.
- Three test-tool attempts are allowed; preparation reads/edits do not consume that
  budget. Existing overall workflow turn, cost and no-progress bounds still apply.
  Background processes cannot evade accounting because this action cannot launch
  them. Old evidence-collector counts cannot exhaust a newly assigned test repair
  before its own budget is used.
- Test commands must be direct invocations of existing runners/package test scripts.
  Shell wrappers, exit masking, `echo`/`cat` mentions and downloading a new runner
  through `npx` are not accepted. Informational flags, empty suites and commands
  without a nonempty supported test-run summary cannot create passing evidence.
  Installing an absent test framework is outside
  this restricted repair action; an implementation/environment repair is needed.
- Terminal `product_failure` reporting uses the existing technical-review hold,
  not customer permission. Tests, build repairs and SQL corrections do not become
  customer decisions when attempts exhaust. Real product decisions/credentials
  remain distinct. Applied-migration drift diagnostics now explain exact-byte
  restoration rather than suggesting that appending a migration alone is enough.

## Rollout and limitations

Deploy the API through the normal deployment process. No database DDL is required.
Existing blocked/cancelled items are not reopened, budgets are not reset, and no
production workflow, customer SQL, remote source or requirement status was changed.
Reconcile the existing two incidents before resuming them; deployment alone does
not restore NEX's file or reopen Content Factory's cancelled work.

Tests use existing offline Jest/PGlite harness infrastructure and mocked sandbox
execution. They are not a claim of a live end-to-end run or a production deployment.

Validation: **130 suites / 1,699 tests passed** (`npm run test:harness`). The full
TypeScript check reports 157 errors outside the changed files; no errors were
reported in files changed by this task. `git diff --check` passed.