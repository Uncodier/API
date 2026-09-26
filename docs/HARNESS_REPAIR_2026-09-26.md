# Harness correctness and bounded execution repair

## Scope

This repair keeps the durable workflow/CAS architecture. It fixes false completion,
premature recovery blockers, stale execution ownership, calendar-bound scheduling,
and repeated sandbox preparation. It does not deploy changes or apply migrations.

### Correctness

- Interactive plans return `execution_status: exhausted`, `success: false` and
  `resumable: true` when a batch reaches ten turns without finishing. Later steps
  are not executed. The incomplete step stores its continuation in
  `result.assistant_execution`; a running/ambiguous checkpoint requires
  reconciliation rather than replaying effects. The multi-effect durable step
  has automatic retries disabled.
- `enforceSingleTurn` permits one tool execution attempt, not just one LLM
  response. Additional tool calls receive explicit non-executed results to keep
  provider history valid. Failed tool attempts are not blindly retried in this
  mode. Existing streaming token-accounting corrections are preserved.
- Required app/site database migrations must have a current passed receipt.
  Failure stops delivery/push from that phase; a missing receipt cannot satisfy
  finalization. SQL/lint defects and infrastructure failures are distinguished.
  Product migration defects currently request intervention; this repair does
  not synthesize or approve a new migration automatically.
- Pre-push build results use the exit code, including failures with empty or
  unreadable output. Origin recovery that changes the validated workspace
  invalidates its test/runtime evidence and requests a bounded revalidation;
  it cannot reuse old passing receipts for new files.
- New cron wrap-up calls use a typed recovery disposition. A transient failure
  remains retryable until the durable circuit exhausts its budget. The wrap-up
  tool cannot override the recovery decision or complete a requirement itself.
  Text-prefix interpretation remains only for older queued payloads.
- Accounting errors still propagate, but a `finally` attempts owner-checked
  release so a failed ledger write does not strand the lease.

### Execution ownership and deployment order

The new migration is
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20260926070000_harness_execution_ownership.sql`.

1. Pause new requirement scheduling and drain or explicitly stop old in-flight
   executions through normal operational controls. Review old eligible backlog
   and recurring requirements: removing the calendar cutoff makes them eligible
   again; it does not automatically approve or unpause them.
2. Inspect applied migrations and deploy this forward migration to the intended
   database using the existing migration procedure. It requires the earlier
   capacity/lock migrations. Do not reapply historical migrations.
3. Deploy the API containing the new guards, then resume scheduling and canary
   a small workload. If rolled back, roll back API and scheduling policy together;
   old workers do not implement the new execution ownership contract.

The new service-role-only RPC validates run owner, execution generation, live
lease, activation and runnable state. Cleanup may allow terminal status but
never bypasses owner/generation/expiry. Missing RPCs **fail closed** with an
explicit migration error; deploying the API first will pause execution.

The scheduler no longer excludes work created before the current month. Stale,
expired or frozen lease revocation advances the requirement generation. Normal
unowned claims preserve it so no-progress accounting is not reset each cycle.
Step execution retains its original step-generation expectation rather than
adopting a newer writer's state. Guards run again at tool dispatch and critical
sandbox/push boundaries. They cannot undo an external operation already in flight;
provider-side idempotency and true multi-connection stress testing remain necessary.

### Runtime cost controls

- The cron step loop now reads `max_turns_per_step` from the flow registry (five
  per step per cycle by default) rather than a hardcoded thirty. Exhaustion yields
  to the next cycle; it is not completion.
- The scheduler uses the same registry for the coarse cycle circuit: fifty
  cycles per backlog item by default, capped at the configured requirement
  envelope (3,000). `CRON_CYCLES_PER_BACKLOG_ITEM` remains a positive-integer
  override, but cannot exceed the requirement ceiling. This circuit uses the
  existing `cron_attempts` accounting; it is not a monetary lifetime ledger.
- Mid-cycle `fastAttach` rechecks a healthy running session, canonical repository
  root, requirement branch and dependencies without remote fetch/reinstall/Next
  restart. Actual recovery still performs warm preparation. It does not cache
  permissions or execution ownership.
- Runtime probes bound curl connections/requests and the complete write/run/read
  operation. Default total timeout: 60 seconds; maximum: 120 seconds; independently
  bounded cleanup: five seconds. Server-side command timeouts complement transport
  cancellation. Retained probe servers have an orphan lifetime limit.

## Local validation

From `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```sh
npm run test:harness
```

The dedicated Jest config includes behavioral fault-injection tests, existing
gate/backlog invariants and real migration SQL executed using in-memory PGlite.
It excludes fixture-only files and does not load Next config or `.env` files.
The GitHub Actions job runs this same command on Node 22, without credentials or
production calls. PGlite checks are not proof of multi-connection race behavior;
validate concurrent claims/resumes against staging PostgreSQL before rollout.

Local result at this checkpoint: 89 suites / 681 tests passed on Node 22.
The last type-only edits also passed 21 focused gate/finalization/ownership tests.

The repository-wide TypeScript check has unrelated existing errors (including
generated `.next` validators). Harness regression success does not assert that the
whole application builds cleanly or that these changes have been tested in a live
Vercel sandbox.

The probe uses the existing configurable server port. Coordinating a pre-existing
server on that port with the server started for a new probe remains a separate
runtime concern; a successful HTTP response alone is not proof that the newest
process served it. The Linux sandbox image must provide `setsid` and `timeout`;
missing tools fail the probe rather than running it without bounds.

## Follow-up measurement, not implemented here

A real currency/token reservation ledger, model routing, production dashboards
and a representative end-to-end task evaluation dataset are separate work. No
latency or cost saving percentage is claimed by these local changes. Track cost
per accepted task, intervention rate, false completions, turn counts, preparation
time and p50/p95 latency to assess the impact after a controlled rollout.