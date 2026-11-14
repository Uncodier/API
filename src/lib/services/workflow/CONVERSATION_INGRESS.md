# Conversation ingress (API contract)

`customerSupportMessage` and `answerWhatsappMessage` submit scoped messages using
Temporal `signalWithStart('conversationIngressWorkflow', ...)`. The coordinator
must be deployed on the selected task queue before enabling these API changes.

- Coordinator ID: `conversation-ingress-${siteId}-${sha256(scope)}`.
- Scope: the raw conversation ID, otherwise JSON of
  `['zavu', channel, connection_id, zavu_sender_id, zavu_from]` from complete
  internal Zavu ingress metadata (`source: 'zavu_inbound_message'`, delivery
  enabled, channel matching origin). Missing site or scope keeps direct execution.
- Start args: `[]`; signal: `submitConversationMessage`; signal args:
  `[{ workflowId, workflowType, args, taskQueue }]` with the existing per-message
  ID and unchanged argument array, including support's second metadata argument.
- The coordinator owns FIFO child startup/result waiting and must deduplicate
  repeated submissions of the same per-message workflow ID. Children must not
  wait on a second conversation gate when their parent is this coordinator.

Async success means **durably accepted**, not necessarily child started:
`{ success: true, workflowId, status: 'running' }`. `workflowId` always identifies
the per-message child. `executionId` and `runId` are absent for queued ingress;
coordinator IDs must never be substituted. There is no async admission polling.
Unscoped async direct starts retain their existing execution/run IDs.

Customer support remains async by default. WhatsApp retains its existing sync
default; explicit `async: true` returns on admission.

The coordinated sync contract uses the per-message handle's `describe()` rather
than a coordinator query (the coordinator does not expose an admission query).
Only `WorkflowNotFoundError` is retried, every 250ms for up to five minutes;
once described, `getHandle(workflowId, runId).result()` supplies the child result.
Result waiting itself is not bounded. An admission timeout does **not** cancel
the accepted message; retain the per-message ID for subsequent recovery. Other
Temporal errors and child failures use the service's existing error response.

Offline checks:

```sh
node ./node_modules/jest/bin/jest.js --config jest.conversation-ingress.config.js --runInBand
```