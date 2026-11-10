# Chat audio responses

## Contract

`response_format` is an optional `text | audio` delivery preference. Audio is
supported for WhatsApp, Telegram and Messenger, not Instagram DMs, public
comments, email, SMS or voice calls. An omitted delivery preference retains the
legacy adapter behavior. Explicit text bypasses both long-reply synthesis and
audio-URL extraction from text.

Customer Support chooses a response format alongside the response content;
explicit request selection wins. The support endpoint generates the response
text and persists the format, not an audio file or an external delivery. Temporal
owns the subsequent delivery. Human chat interventions save the operator's text
and selection before starting that same channel delivery path.

The UI uses Text / Audio, with Text initially selected, to the right of the
channel selector. Only the three supported messaging channels expose it. Internal
agent chat and public-comment replies remain text. Existing authentication and
conversation-derived routing remain authoritative.

Manual audio stores its resolved `connection_id` before starting the workflow.
Resolution uses a saved message binding, then the conversation binding, then
unique scoped inbound account metadata. With no binding, only a single usable
sender is allowed; multiple candidates, mixed inbound accounts, stale bindings,
and truncated history fail closed rather than choosing the first connection.
The dedicated legacy WhatsApp route stays separate from Zavu and is revalidated
before dispatch.

## Delivery and retries

Explicit audio requires a saved `message_id` and `conversation_id`. The API
verifies site/conversation/message scope and the saved content, then synthesizes
MP3 through Azure using the configured voice. Spoken text is limited to 4,000
characters; unsupported/empty input fails rather than truncating or sending text.
WhatsApp requires an active response window, rechecked before dispatch; the audio
branch never creates a text template.

`messages.custom_data.audio_delivery` is a compare-and-set receipt bound to text,
channel, recipient and sender. States are `preparing`, `ready`, `dispatching`,
`sent`, `unknown` and `preparation_failed`. The attachment is stored alongside
the receipt for chat playback. Completed sends reuse the provider receipt;
concurrent attempts cannot claim the same message. The audio activity uses one
attempt. Neither an uncertain provider response nor an interrupted preparation
automatically permits another send/charge.

Direct and approved delivery use the same versioned provider sender identity
(Zavu sender ID; Twilio account SID and From number), independent of local
connection aliases. This lets either path recognize a completed receipt or
resume a prepared one. A Zavu message ID alone is not acceptance: failed,
cancelled, unknown and explicitly unsuccessful provider results are rejected.
If receipts were created by the pre-release implementation using the old sender
key shape, reconcile them before rollout; do not clear them or resend blindly.

An interrupted/failed preparation or uncertain dispatch needs reconciliation:
inspect the existing receipt, billing and provider result. Do not blindly clear
the receipt or create another message to retry. This favors avoiding duplicates
over automatic recovery. There is no automatic refund or reconciliation worker
in this change. A failed preflight without a receipt can be retried with the same
saved format after resolving eligibility/configuration.

Approved support audio preserves a saved exact connection: WhatsApp and Telegram
use an explicit audio branch in the exact-delivery endpoint; Messenger uses the
channel adapter with its saved connection pinned. All use the same audio receipt.
Managed outreach remains a separate module and refuses an explicit chat-audio
payload rather than silently sending text. Native voice-note presentation on
every provider is not guaranteed.

## Rollout

Changes span the API, Workflows and market-fit repositories. Deploy compatible
API handlers and Temporal workers before exposing the frontend selector. Temporal
support/approval propagation uses patch markers to preserve replay compatibility.
No database migration is required; metadata lives in existing JSON columns.

Offline tests cover synthesis, short audio, explicit text, window enforcement,
scope/content checks, concurrency, persisted receipts, uncertain delivery,
request propagation, support output selection, UI submission paths and retries.
Provider delivery and browser end-to-end checks still require a configured test
environment; offline tests are not proof of live delivery.