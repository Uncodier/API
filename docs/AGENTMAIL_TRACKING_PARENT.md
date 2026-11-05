# Standalone AgentMail email and tracking parents

`sendEmailCore` supports outbound email without a conversation. SMTP only creates
a tracking message when a conversation is supplied; AgentMail must follow the same
rule. `messages.conversation_id` is an operational parent required by the deployed
location ACL trigger. Do not relax that constraint to accommodate standalone email.

`AgentMailSendService` now creates a new tracking message only when
`conversation_id` is nonblank. Without a conversation it still sends through the
configured provider and records a successful provider receipt in `synced_objects`;
it does not inject a message tracking pixel or fabricate a conversation. An
existing centrally owned tracking ID retains its existing behavior.

This fixes the orphan INSERT that produced `23503 Operational parent required`.
It does not bypass provider rejection: suppressed/bounced recipients can still
be rejected by AgentMail, and no sent receipt is claimed for those failures.
Successful-send receipt persistence remains the existing best-effort behavior.

No database migration is required for this email change. Deploy the API. Offline
coverage is in the transactional-email suite and includes standalone sends,
conversation-backed tracking, centrally owned tracking and provider rejection.