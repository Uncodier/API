# Human-intervention voice lifecycle

`POST /api/agents/chat/intervention` requires an authenticated user, access to
the existing conversation's site, and insert/update permission. Actor and
conversation resources are resolved server-side. API keys additionally require
write scope; a service credential without a bound user is not a human author.
The endpoint no longer implicitly creates or renames conversations.

Pressing Send in Conversations approves the authenticated team member's own
intervention. The API inserts the message with `status: accepted`,
`command_status: pending` and `dispatch_owner: chat_intervention` before attempting
delivery. This is human approval, **not** a provider receipt. Direct dispatch owns
the row; the scheduled approved-message batch must not send it a second time.
Deploy the queue/claim exclusions before rolling out these API writes. This
does not approve assistant drafts or retroactively enqueue historical messages. For
the persisted `voice` channel, delivery uses the existing tracked Zavu call
service directly, **not Temporal**. Other channel workflows are unchanged.

Inbound terminal call webhooks separately create/reuse and link a minimal
site-scoped CRM lead before transcript projection. This does not grant outbound
call consent. See [Inbound voice lead linkage](./ZAVU_INBOUND_VOICE_LEAD_LINKAGE.md)
for conflict handling, retries and explicit historic-repair limits.

## Response and state

The response retains `data.message.message_id` for the saved row:

- Accepted call: `channel_send.success: true`, `method: "voice_agent_call"`,
  `callId`, and `delivery_status: "accepted"`. Acceptance is not call completion.
- Known placement rejection: `channel_send.success: false` and
  `delivery_status: "failed"`. The server records a failed message state.
- Ambiguous placement: `channel_send.success: false` and
  `delivery_status: "placement_unknown"`. The command remains pending; clients
  must reconcile the saved row rather than mark it failed or automatically retry.

A provider call ID remains acceptance evidence if a later database write fails.
Placement and webhook updates set `command_status` to `success`, `failed`, or
`pending` consistently with message state. Placement writes use compare-and-set
to avoid overwriting newer callbacks. Terminal delivery rows are not regressed
to queued by a late placement response.

Retries require the original author, conversation, role, unchanged content,
and a failed state without advanced delivery evidence. An atomic claim restores
the same manual-approval metadata, leaving command execution pending, and
prevents concurrent retry requests from both sending. Existing call or
unknown-delivery records are never automatically redialed, including failed
delivery claims that require separate reconciliation.

Generic non-2xx errors with a saved ID do not prove external execution never
started. No generic `execution_started: false` assertion is made.

## Offline validation

Run `npm run test:voice -- --no-cache` for the voice integration suite. The
intervention route/helper/retry suites are under
`src/app/api/agents/chat/intervention/__tests__`; run them with the CommonJS
voice Jest configuration by overriding `--testMatch` to that directory.

These tests do not establish the original no-save incident's runtime cause or
verify live provider behavior. Do not use live calls as regression tests.