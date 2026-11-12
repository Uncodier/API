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
WhatsApp audio requires an active response window, rechecked before dispatch.
For Zavu WhatsApp with a closed window, the same saved response is delivered as
a text template instead, subject to Meta approval. The legacy Twilio audio path
still requires an active window; its existing non-audio template workflow is unchanged.

### Zavu closed-window template fallback

The template contains the exact prepared message, not an audio header, automatic
summary or silently shortened version. It must contain 1–1024 characters with no
unresolved `{{variables}}`. Unsupported content fails explicitly. The language is
loaded from `settings.default_locale` and normalized to a supported WhatsApp code
(for example `es-MX` -> `es_MX`, `pt-BR` -> `pt_BR`). Missing locale defaults to
`en`; an invalid locale fails before submission. The field specifies the template
language; it does not translate the message. Prepare content in the intended
language before requesting delivery.

Template creation uses Zavu `/v1/templates` (`whatsappCategory: UTILITY`), submission
uses `/v1/templates/{id}/submit` with the selected `senderId`, and dispatch uses
`/v1/messages` with `messageType: template`, `content.templateId`, `Zavu-Sender`
and an idempotency key bound to the saved message. Meta can reject or recategorize
the content; creation/submission does not imply approval or delivery.

`custom_data.template_delivery` owns the saved message exclusively, using CAS
updates. An audio receipt blocks template fallback and a template receipt blocks
audio generation, including if the customer reopens the window during approval.
Requested format remains `audio`, but `delivery_format` is `template`. Pending
approval returns HTTP 202, `template_pending: true`, `status: template_pending`,
the local message ID and template ID. The workflow polls that same operation with
bounded waits through the approval deadline. Pending is never counted as sent.
Approval dispatch revalidates body, language and selected sender. A confirmed
provider acceptance sets `template_used: true`; no second audio is generated.

Rejection and a 24-hour approval timeout persist specific errors. The final
provider status is read before declaring timeout: an approved template discovered
at that check is not discarded. Approval checks use short initial waits followed
by hourly checks through the deadline. Creation,
submission and dispatch uncertainty are never automatically replayed: the receipt
remains for reconciliation. Manual Retry cannot take ownership from a template
workflow. Provider acceptance is not proof of delivery to the handset.

If an already-pending poll fails, Temporal reconciles through the authenticated,
read-only `GET /api/agents/tools/templateDeliveryStatus` endpoint. Only a scoped
`ready`/`pending` receipt permits a later dispatch attempt; `dispatching`, unknown,
failed or rejected receipts never authorize a resend. Accepted receipts complete
the operation without another POST to the provider. Failed status reads are
retried within bounded limits. When recovery cannot continue, a separate
idempotent control POST marks `needs_reconciliation` without changing receipt
ownership. If the database is also unavailable for that control write, the
workflow exposes `reconciliation_persisted: false`; an operator must reconcile
the saved identifiers after service recovery.

New template receipts persist `state: accepted`, `delivery_status: queued` on
provider acceptance, not successful delivery. Signature-verified `message.sent`,
`message.delivered`, `message.read` and `message.failed` webhooks reconcile the
provider message ID, sender, recipient and tenant with compare-and-set updates.
Late queued/sent events cannot overwrite failure; confirmed delivery/read is
stronger than a delayed failure event. If the callback arrives before the HTTP
response saves the provider ID, webhook processing asks Zavu to retry rather than
guessing a recipient match. The UI distinguishes accepted, sent, delivered, read
and failed and keeps all template receipts protected from manual resends.

Provider reference: [Create template](https://docs.zavu.dev/api-reference/create-template),
[Submit template](https://docs.zavu.dev/api-reference/submit-template-for-approval),
[Send template](https://docs.zavu.dev/guides/whatsapp/templates/sending).

`messages.custom_data.audio_delivery` is a compare-and-set receipt bound to text,
channel, recipient and sender. States are `preparing`, `ready`, `dispatching`,
`queued`, `sent`, `delivered`, `read`, `failed`, `unknown` and `preparation_failed`. The attachment is stored alongside
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

### Audio receipt reconciliation (local repair, 2026-11-12)

New explicit receipts persist the site, channel, recipient, versioned sender
identity, provider, Zavu sender ID and saved connection ID when present. Signed,
durably admitted Zavu queued/sent/delivered/read/failed callbacks now reconcile
audio as well as templates. The configured sender resolves exactly one site;
the saved conversation channel and receipt destination must match. Duplicate
and out-of-order callbacks cannot regress a receipt: failure outranks sent/queued,
while delivered/read outrank failure. Confirmations clear stale failure metadata.

Legacy audio receipts without sender fields require an exact saved message or
conversation connection in that site's settings and verification of the original
raw-text/channel/recipient/versioned-sender hash. Unbound, stale, duplicate,
Twilio-bound or unverifiable legacy receipts are not guessed or backfilled.

A callback preceding provider-ID persistence fails its durable webhook claim so
Zavu can retry after persistence. It never attaches the ID by recipient or resends.
Dispatch completion uses CAS and reloads after a lost write, preserving any
webhook-confirmed delivered/read/failure receipt and unrelated concurrent metadata.
Completed delivered/read retries reuse the provider ID; failures stay blocked.

`pending` without a receipt is a saved draft marker, not proof of dispatch. In
contrast, `sending`, `sent`, `delivered`, `read`, `placement_unknown`, an existing
provider ID or `needs_reconciliation` without a receipt blocks audio generation.
Preflight failure marking also preserves these ambiguous states and all existing
receipts. Database lookup/write failures do not prove that sending never started;
the reported statement-timeout incident is not resolved by this code and its
saved row is not changed here. Operators must reconcile ambiguous historical
rows rather than clear a sending marker to authorize another attempt.

Offline focused checks use the existing `jest.ai.config.js` (explicit audio and
audio/template receipt suites) and `jest.voice.config.js` (webhook route suite).
No live provider send, database migration, remote repair, deployment or worker
change is included. Callback retries depend on the provider retry policy; there
is no new reconciliation poller or recovery of receipts whose ID was never saved.

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