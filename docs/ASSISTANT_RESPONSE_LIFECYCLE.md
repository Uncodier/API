# Assistant response lifecycle

`POST /api/robots/instance/assistant` persists the user action before starting
the workflow. It passes that server-created log ID into the workflow so the
same turn is not inserted a second time. `request_id`, when supplied, is saved
in the log details for client-side correlation; it is not a workflow
idempotency key. Do not blindly retry an ambiguous started request.

The response is SSE with `X-Assistant-Stream-Version: 1` and
`X-Workflow-Run-Id`. Events contain `type`, `run_id`, and `instance_id`:

- `accepted`: `success: true`, `user_log_id`. The user action is saved and the
  workflow has started. This is **not** completion.
- `completed`: `success: true`, `data` contains the workflow result.
- `error`: `success: false`, `error: { code, message }`. A failed/cancelled run,
  incomplete plan, unavailable status, or response timeout is visible even
  when writing an error log fails.

Completed/failed user-log checkpoints preserve the request ID. A paused plan
is marked `paused` rather than left `running`. Background continuations retain
the original user-log ID for their terminal checkpoint and report
`ASSISTANT_WORKFLOW_CONTINUING`, not a fabricated successful answer.

The API observes the workflow status and reads its return value on completion.
It does not return the unused `run.readable`: this workflow writes its output
to `instance_logs`, not to `getWritable()`. Consumers must handle terminal
events, disconnected streams, and EOF without a terminal event rather than
treating SSE headers as successful execution. Keepalive comments are not
completion either.

The connection has a bounded lifetime (750 seconds). Disconnecting stops
status polling but does not cancel durable work. A timeout/unavailable status
does **not** prove the workflow failed; its message instructs the client to
check the session before retrying. HTTP startup failures use a JSON error and
attempt a scoped error log without delaying that response indefinitely.

The browser application in the sibling `market-fit` repository has a matching
SSE consumer and sends assistant requests through its authenticated same-origin
proxy. Deploy both repositories together. Existing runs are not automatically
restarted, and older clients that discard SSE data will not show these errors.

## Bound canvas continuation

New executions save an `assistant_recovery` checkpoint on their trusted
`user_action`. It preserves the original node ID, context string, tool overrides,
selected instructions, message transcript/tool receipts, and response-node IDs.
The snapshot fingerprints the node and its Content/context references, including
an implicit parent. Moving UI coordinates does not invalidate it; changing
content, references, destinations, or deleting/moving a referenced node does.

Node execution is split into bounded chunks. A tool call at the end of a chunk
is not completion: the next chunk receives the same transcript and response node,
not a fresh generic assistant or a new response child. Partial parallel fan-out
cannot be replayed safely and is paused instead of duplicated.

Both workflow and cron recovery must claim this checkpoint for the original
user action. They cannot infer work from the latest tool log. Recovery refuses
missing/unbound checkpoints, stopped/cancelled/completed/failed/paused or superseded
actions, changed node context, concurrent owners, and in-flight node/plan work.
Ordinary in-flight conversations may resume using the
[15-minute heuristic](ASSISTANT_HEURISTIC_RECOVERY.md), without automatically
replaying a tool. An in-flight crash still has an uncertain outcome. Revision
compare-and-set and generation fencing prevent stale executions from resuming
after another owner claims recovery. The maximum of five background restarts is
per action, not reset when the cron lookback window expires.

A known conversational turn alongside a requirement plan may recover in
conversation-only mode. It can read status and finish the user's answer without
resuming the plan or releasing its holds. Only that user action is completed;
the response reports `conversation_completed` and `managed_work_resumed: false`.

Before each model chunk and tool invocation the active action and fingerprint are
checked again. `publish` arguments are bound to persisted Content output URLs and
saved social destinations at the tool execution boundary; a video cannot be
replaced by its reference images or all instance assets. Model-authored captions
and explicit TikTok options remain configurable. Blog-only nodes cannot add a
social destination. Missing/unsafe Content fails closed.

Checkpoints are JSON-only and limited to 2 MiB of messages, without inline data
URIs. Oversized/nonserializable context pauses rather than dropping receipts.
Execution configuration retains its separate 512 KiB limit; the snapshot reserves
another 64 KiB for recovery metadata and fits within the existing 4 MiB action reader.
These are safety checks, not an atomic transaction across external providers:
already-started external requests cannot be undone by a later cancellation.
No historical rows or respawn counters are reset on rollout. Eligible running
conversations in the cron discovery window can resume automatically.
No remote schema migration is required. Deploy the API before relying on recovery.

New offline suites cover `node-recovery-workflow`, `recovery-turn-guard`,
`publish-node-binding`, `bound-recovery`, `bound-respawn`,
`assistant-node-continuation`, and `assistant-recovery*`. They run with `npm test
-- --runInBand <test-paths>` and mock all model/provider/database effects.

Offline regression coverage: `route-lifecycle.test.ts`, `response-stream.test.ts`,
`user-message-log.test.ts`, and `plan-exhaustion.test.ts` under
`src/app/api/robots/instance/assistant/__tests__`, included in `npm run test:harness`.