# Assistant interrupted-turn continuation

The assistant respawn cron can resume an abandoned conversation even when the
previous model/tool turn never saved its final checkpoint. This resumes the
**agent**, not a stored tool call. It is deliberately heuristic, not an
exactly-once execution guarantee.

## Policy

- Completed checkpoints retain the existing 3-minute inactivity threshold.
- In-flight turns require **15 minutes without activity**, checked again when
  claiming recovery. The threshold exceeds the 800-second assistant HTTP budget
  plus a margin; it is not proof that all external operations have stopped.
  Generated Workflow configuration asks for the platform maximum, so the
  explicit 300-second configuration alone is not used as a hard guarantee.
- The cron runs every minute. It scans recent activity (30 minutes) and also up
  to 200 trusted running in-flight actions created in the last 24 hours, so a
  stranded turn does not immediately disappear from discovery after 30 minutes.
  These bounded scans are not an unlimited historical backfill.
- The existing two-respawn cap and cooldown remain. Cancellation, superseding
  user input, changed node bindings, ambiguous workflow admission, and work
  owned by another workflow/requirement remain protected.
- This heuristic applies to ordinary assistant conversations. Plan execution
  and in-flight canvas nodes are not restarted this way: their output writers
  need separate ownership fencing. Existing complete-checkpoint node recovery
  still requires its original response-node continuation. Legacy snapshots with
  an active plan are skipped because they cannot identify the execution phase.

## Evidence and ownership

Before the model turn, the original messages and start/activity timestamps are
persisted. Before and after each sequential tool, a bounded, redacted observation
is saved on the same trusted action. The latest eight observations retain the
tool name, arguments, outcome (`unknown`, `returned`, or `threw`), and result
summary. A return is not necessarily business success; an exception does not
prove that the provider rejected the operation.
Streaming log checkpoints also persist an activity timestamp; updates to an
existing log count as activity, not just newly inserted rows.
If saving an observation fails after an effect, the executor propagates the
recovery error rather than fabricating a failed tool reply or retrying that tool.
The uncertain observation remains available to the next heuristic continuation.

The recovery claim independently checks inactivity using the action timestamps
and latest scoped logs, then uses the existing status/revision compare-and-swap
to acquire a new generation. Old generations cannot start further guarded tools,
overwrite the checkpoint, or finish/fail the newly resumed action. A request
already accepted by an external provider cannot be undone by this fence.

The resumed model receives the preserved transcript and a separate context
section with the observations and up to five recent legacy tool logs. The section
explicitly treats log/argument/result text as untrusted evidence, not instructions.
It tells the agent to inspect current state, decide whether repeating the last
operation is necessary, and continue without asking for confirmation merely
because execution was interrupted. No successful tool reply is invented and no
tool is automatically replayed by the recovery service.
Interrupted-operation context survives subsequent turn checkpoints and is
merged (within its byte cap) on another interrupted recovery, so an unresolved
effect is not forgotten merely because the agent completed a later read.

Old snapshots without new timestamp/evidence fields remain readable. The claim
uses the trusted action creation time and scoped logs as fallback; if a first
turn has no transcript, its original trusted message supplies the starting intent.

## Limits

This policy trades indefinite stalls for autonomous continuation. It does not
guarantee that the model will never duplicate an external effect. Provider-side
idempotency and operation-status checks are still necessary for strict duplicate
prevention (for example, payments or email sends). No production data migration
is required: metadata is stored in the existing recovery JSON. Deploying the new
code is required before any production instance uses it.

## Offline validation

Focused Jest coverage lives in `assistant-stale-recovery.test.ts`,
`assistant-recovery-context.test.ts`, `assistant-respawn-policy.test.ts`, the
assistant respawn cron route tests, and existing recovery/workflow regression
suites. Tests cover fresh/stale boundaries, legacy snapshots, evidence handling,
concurrent claims, stale writers, cancellation, node binding, redaction and the
real Workflow compiler boundary without provider calls.