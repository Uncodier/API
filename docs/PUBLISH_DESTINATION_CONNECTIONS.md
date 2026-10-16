# Exact publish destination connections

`publish` and `sendBulkMessages` preserve site-scoped destination identities,
including multiple connections on the same channel. No migration is required.

## Stored node contract

`instance_nodes.settings.publish_destinations` contains:

- Distribution: `${mode}:connection:${encodeURIComponent(connectionId)}`.
  Modes: `mail`, `newsletter`, `whatsapp`, `telegram`, `sms`, `voice`,
  `voice-agent-call` (`email` remains a legacy synonym for `mail`).
- Social: `${platform}:social:${encodeURIComponent(accountId)}`.
- Local content: `blog`.

Opaque IDs are decoded once and never lowercased. Malformed encodings, unknown
types, empty IDs, control characters, duplicate routes, and oversized lists fail
closed. Legacy network/mode names remain accepted only through authoritative
unambiguous account resolution, not a first-account choice.

The API binds both tools to the persisted node selection on initial execution and
continuation. Stale context, client overrides, and model arguments cannot add a
connection or account. A social-only node cannot invoke bulk delivery. Absent
destinations default to Blog only when the authorized site's stored URL exists;
an explicit empty selection is rejected.

## Tool contract

One destination:

```json
{
  "audience_id": "audience-id",
  "channel": "email",
  "connection_id": "email-2",
  "audience_email_mode": "newsletter",
  "subject": "News",
  "message": "Hello"
}
```

Multiple destinations replace top-level channel/connection/mode fields:

```json
{
  "audience_id": "audience-id",
  "delivery_routes": [
    { "channel": "whatsapp", "connection_id": "wa-2" },
    { "channel": "email", "connection_id": "email-2", "audience_email_mode": "mail" },
    { "channel": "voice", "connection_id": "voice-2", "voice_mode": "agent_call" }
  ],
  "subject": "News",
  "message": "Hello"
}
```

`publish` uses `text` instead of `message` and can also take `social_accounts`
with exact site account IDs. Typed social destinations additionally use
`social_account_targets: [{id, network}]`: a missing exact ID never falls back to
another account's username/platform, and the expected network must match.
Bound publish nodes cannot bypass the selected destinations through alternative
outbound/integration mutation tools, or add an Instagram DM target.
Email requires a subject (publish may use its title).
Voice agent guidance remains private `objective` / `additional_context`, not the
spoken greeting. Mail defaults to queued conversational delivery; Newsletter
uses immediate tracked provider delivery without conversations/signatures.

Reserved legacy selections are `legacy:email`, `legacy:agent_email`,
`legacy:whatsapp`, and `legacy:agent_whatsapp`. These select independent stored
legacy configurations. They cannot alias real connection IDs. Missing, disabled,
suspended, wrong-channel, foreign, or ambiguous accounts reject **every route
before content writes, templates, queue insertion, or live sends**. Zavu connections
must be connected, have a sender ID, and have an active email channel when used
for email. A pure preview makes no connectivity claim.

## Queue and provider fidelity

Queue rows persist `custom_data.connection_id` on both message and conversation.
Pending audience recipients are snapshotted once for multi-route sends: delivery
to route one must not consume the recipients for route two. Recipient status is
aggregated after the selected routes complete. Counters for Mail and other queued
channels describe handoffs, not confirmed provider delivery.

Legacy WhatsApp prepares campaign templates using the selected account's own
credentials and persists template metadata/variables. Zavu WhatsApp never creates
a Twilio template. Provider dispatch revalidates the exact connection and never
falls back to another sender, SMTP account, or AgentMail account. A queued worker
must use the exact delivery API rather than dropping the stored connection ID.
The provider adapter and queued endpoint carry site/message identity; ambiguous
provider acceptance is not automatically retried.

Exact Twilio sends pin the configured WhatsApp phone number even when a
Messaging Service is configured; service-only configurations cannot claim a
specific sender. Campaign preparation reuses only an identical account-owned
template, never a merely similar campaign. Zavu replies require a documented
accepted message state as well as an ID, including HTTP 409 replay responses.
Zavu email carries separate HTML and plain-text bodies, the applicable signature,
and tracking links for persisted message IDs. Accepted AgentMail receipts retain
the canonical message/thread/inbox IDs used by delivery and bounce callbacks.

Multi-route orchestration is not a distributed transaction. A provider failure
can occur after an earlier route was queued or sent. Inspect existing delivery
records before retrying; do not replay accepted routes as a new publication.
The shared audience status is not a per-route retry ledger, and this change does
not introduce a new migration or promise exactly-once delivery across providers.

## Test recipients

`publish` with `is_test: true` performs no social/local publication. Providing a
test recipient performs a real single-recipient send through each selected
connection. Mixed channels use `test_recipients: {email, phone}`; one scalar
`test_recipient` is retained for compatible single-channel callers. A
`test_lead_id` supplies defaults and merge fields, but must belong to the site.
All route IDs and recipient formats are validated before the first test send.
WhatsApp outside its reply window still requires an approved exact account-owned
template; test mode never authorizes a different connection.

Voice Agent Call tests require a same-site lead with granted consent and a
matching phone. They create server-issued conversation/message tracking records
before placing the call through the selected connection. Test preparation and
failure states are not approved-message queue states; failures or ambiguous
placement cannot silently trigger another outbound test.

## Offline verification

```bash
npm test -- --runInBand src/lib/messaging/__tests__/delivery-routing.test.ts src/lib/integrations/outstand/__tests__/accounts.test.ts src/app/api/agents/tools/sendBulkMessages/__tests__/exact-routing.test.ts src/app/api/agents/tools/publish/__tests__/assistantProtocol.test.ts src/app/api/agents/tools/publish/__tests__/social-publishing.test.ts src/app/api/robots/instance/assistant/__tests__/publish-node-binding.test.ts src/app/api/robots/instance/assistant/__tests__/publish-tool-overrides.test.ts src/app/api/robots/instance/assistant/__tests__/recovery-turn-guard.test.ts
node node_modules/jest/bin/jest.js --config jest.exact-delivery.config.mjs --runInBand
node node_modules/jest/bin/jest.js --config jest.voice.config.js --runInBand --runTestsByPath src/app/api/agents/tools/publish/__tests__/tool-execution-context.test.ts src/app/api/agents/tools/sendBulkMessages/__tests__/tool-execution-context.test.ts
```

The cross-layer regressions execute real adapters, HTTP clients, renderers,
receipt writers and callback lookup with only network/persistence simulated.
The tests do not send production tests,
deploy services, apply migrations, or build the production application.