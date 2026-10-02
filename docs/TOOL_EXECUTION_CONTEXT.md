# Private tool execution context

## Incident

The follow-up flow replaced the operator's concrete request with a generic
"continue the conversation" objective, treated the request as a spoken greeting,
and summarized only the closing turns of the earlier call. In the reported case,
that excluded the original appointment request. Persisted call/contact metadata
alone did not establish that the voice model actually received the purpose.

## Contract

`ToolExecutionContext` is a versioned, tenant-bound second argument to
`execute(args, context)`. It is **not** a model argument or an authorization token.
The assistant wraps tool definitions before the tools router closes over them.
Existing one-argument executors remain compatible; context-aware tools can
consume the second argument without expanding their public parameter schemas.

- `intent`: the originating request, with explicit tool objective taking priority.
- `background`: selected private supporting text, not a full system prompt,
  configuration, or arbitrary conversation dump.
- `source`: allowlisted provenance references (tool, instance, node, conversation,
  message, content, audience). UUID syntax is not permission to read a record.
- Tenant checks, text/serialized budgets and secret redaction run before use.
- Publish explicitly delegates to bulk delivery. Queue-backed messages persist
  `custom_data.tool_execution_context`, so a later worker need not reconstruct
  the originating assistant process. The context is not appended to sent text.
- Adapters must opt in to using/persisting context. Passing it to a legacy tool
  does not automatically make that tool context-aware. Newsletter/immediate
  transports without a queued message are not a new context persistence store.

## Voice

The tracked call service reads the message envelope and persists call guidance
before dialing. Conversation history is scoped to site **and recipient**, with
the source conversation prioritized. Customer requests have a reserved transcript
budget; tool/error diagnostics do not displace the appointment request.

Operator follow-up text is private intent, not a greeting to speak verbatim.
Explicit scripted greetings on the single-call and bulk tools remain supported.

`get_call_context` loads direction, purpose and continuity through the signed tool
webhook. It accepts no model-selected IDs. The server selects a unique active
delivery by authenticated site and caller, verifies it with the provider, then
loads its bound message. Missing, ambiguous, stale or cross-tenant bindings fail
closed. Other conversation-aware voice tools use the same live binding rather
than the lead's most recently updated chat. Context is not identity verification
or evidence that an appointment was successfully booked.

No per-recipient mutation of the shared agent system prompt is used. The provider
documents greeting/duration overrides and arbitrary metadata, not a guaranteed
per-call system-prompt override:
[Voice configuration](https://docs.zavu.dev/guides/voice-agents/configuration),
[Place a call](https://docs.zavu.dev/api-reference/voice-agents/place-a-voice-call).

## Rollout and acceptance

Deploy the API changes and **re-sync the voice agent/tools** so `get_call_context`
and its runtime instruction exist on the provider. Registration and unit tests
do not prove the model invoked the tool in a real call. Do not deploy unrelated
local changes or re-place a historical call automatically.
Instruction-only follow-ups reject placement with HTTP 409 until that capability
is present, instead of silently dialing with a stale metadata-only agent.

The provider's callback `sessionId` is opaque, not a documented call ID. Current
binding uses authenticated site/caller plus a live provider verification. This
does not prove replay isolation between two sequential calls to the same number;
strict per-session binding requires a provider-supported session-to-call mapping.
Do not interpret private context as caller authentication or disclose it verbatim.

For an authorized smoke test, request a follow-up with a specific purpose and
verify the transcript: context tool succeeds, agent acknowledges an outbound
call and its purpose, retains the original request, and checks booking state
before claiming confirmation. Check a second contact for isolation. No live
calls or provider configuration changes are part of the offline test suite.

Run `npm run test:voice` for voice contracts, including signed context retrieval.
The shared-context, publish, bulk, single-call and intervention tests also cover
private propagation, precedence and absence from public payloads.