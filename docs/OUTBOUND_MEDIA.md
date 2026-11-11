# Existing media delivery

Agents can select existing files without generating them. Use the same explicit
contract for WhatsApp, channel sends, exact delivery and Customer Support output:

```json
{
  "message": "Product demonstration",
  "message_type": "video",
  "media_url": "https://media.example.test/demo.mp4",
  "mime_type": "video/mp4"
}
```

The example host is reserved, not a downloadable file. Supply an actual public
HTTPS file URL. `message` (or support `content`) may be empty for media-only sends.
The URL travels as provider media metadata, not as a link in the text. Ordinary
links remain links; there is no image/video URL scraping or generation.

`response_format: audio` still means generated speech from text. It cannot be
combined with an existing attachment. Existing audio instead uses
`message_type: audio` and `response_format: text` (or no speech format).

## Adapters

| Adapter | Existing media |
| --- | --- |
| WhatsApp via Twilio or Zavu | Image, video, audio, document; active response window required |
| Telegram / Messenger via Zavu | Native media payload, subject to provider capabilities |
| Instagram DM | Image/video via connected Zavu sender or authorized Outstand conversation |
| SMTP / AgentMail | File attachments from public URLs, or validated base64 `attachments` on sendEmail |
| Other connected Zavu messaging channels | Native media contract; provider determines capabilities |
| SMS / voice calls | Rejected: these adapters do not deliver file attachments |
| Public social comment replies | Rejected; never converted into a DM or text link |
| Website/chat | Support returns and persists media metadata; the client must render it |

WhatsApp's legacy `media_urls` field is forwarded rather than discarded, but accepts
at most one file per message. Do not mix it with `media_url`. Outside the response
window, no ordinary text template is substituted for a requested attachment.
Legacy sends return `template_required` with the retained media; exact/outreach
sends defer or fail explicitly. Creation of approved media templates is not added.
Bulk messaging retains media on its supported email/Telegram/Zavu WhatsApp
routes. Messenger/Instagram bulk recipient resolution and legacy WhatsApp bulk
media templates remain explicitly unsupported; single-message sends and approved
support replies use their corresponding channel adapters.

## Safety and delivery

- Explicit metadata is shape/MIME validated and must resolve to public HTTPS
  without URL credentials. It is validated again by delivery adapters.
- Zavu/Outstand/Twilio download native media themselves. File existence, actual
  format, codecs, size and availability/expiry remain provider checks.
- SMTP/AgentMail URL attachments reuse the DNS-pinned downloader: 20 MiB,
  20-second download timeout, four redirects at most, HTTPS at every hop, no
  credentials forwarded. Returned MIME is checked before sending bytes.
- Base64 email attachments are limited to ten files and 20 MiB aggregate decoded
  bytes. No local paths, remote URL attachments or arbitrary headers are accepted.
- Tenant authorization, selected-account checks, automation snoozes, approval and
  delivery receipts remain enforced. Provider acceptance is not final delivery.
- Sends with a saved media message ID verify the same tenant, caption and file
  metadata and reject unapproved messages. Saved Zavu connections are pinned;
  unbound saved Instagram media must resolve an authorized Outstand DM and never
  silently falls through to another provider.
  Native saved-media sends claim `native_media_delivery` on the original message
  before dispatch. Successful receipts preserve metadata and update that record;
  missing receipts, timeouts and receipt-write failures remain sticky and require
  manual reconciliation. Resetting `sending` to `accepted` cannot authorize a
  second native media attempt. Email media never falls back from AgentMail to SMTP
  after an ambiguous provider result.
  Legacy WhatsApp `media_urls` requests with a saved message ID are checked against
  the approved canonical attachment too. The saved conversation channel must match
  the requested delivery channel, so metadata cannot authorize a cross-channel send.

## Rollout and verification

Deploy both this API and the updated Temporal worker source at
`/Users/prado/Desktop/Proyectos/Uncodie/Code/Workflows`. Worker changes forward media
through support/approval/channel delivery and use versioned Temporal patches for
new behavior. Deploying only the API does not update already-running workers.
No deployment, live provider send or database migration is performed here.

Offline API suites:

```sh
npm test -- --config jest.media.config.js --runInBand
npm test -- --config jest.support-response.config.js --runInBand
npm test -- --config jest.outreach.config.mjs --runInBand
npm test -- --config jest.exact-delivery.config.mjs --runInBand
```

See `CUSTOMER_SUPPORT_MEDIA.md` for selected-target persistence and reply details.