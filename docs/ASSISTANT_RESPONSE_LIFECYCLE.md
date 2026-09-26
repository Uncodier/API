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

Offline regression coverage: `route-lifecycle.test.ts`, `response-stream.test.ts`,
`user-message-log.test.ts`, and `plan-exhaustion.test.ts` under
`src/app/api/robots/instance/assistant/__tests__`, included in `npm run test:harness`.