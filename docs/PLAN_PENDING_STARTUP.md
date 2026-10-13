# Pending plan startup

The cron executor can start a requirement-owned plan whose steps and bound
backlog item are all `pending`. It does not require a planning agent to have
already activated that item.

`getPlanExecutionGateStep` performs targeted admission through
`requirement-plan-backlog-admission.ts` before applying the strict backlog gate.
Only the item bound to the next authoritative plan step is activated, using the
existing backlog-revision CAS. Admission does not consume product attempts,
reset budgets, change plan steps, or complete any work.

The admission preserves dependency completion, WIP=1 (including Critic/Judge
review), quarantine, pending cancellation, requirement execution holds and
product-attempt budgets. Infrastructure waits/circuits do not activate pending
work. After admission, the executor refreshes plan status, step binding and
generation. Original cron ownership checks and dispatch guards remain in place.

An ordinary pending item waiting for admission stays intact rather than having
its plan cancelled as stale. Terminal and non-pending stale-item handling, and
the dedicated migration-validation-only path, remain unchanged. Legacy plans
without requirement metadata use the explicit cron requirement context; plans
explicitly owned by another requirement are rejected.

## Validation

From the API repository, run:

```sh
npm run test:harness -- --runTestsByPath \
  src/lib/services/__tests__/cron-plan-pending-startup.test.ts \
  src/lib/services/__tests__/cron-execute-steps-phase-helpers.test.ts
```

These are offline regressions, not production execution verification. This
change requires an API deployment to affect live robots; no migration or manual
production status change is included.