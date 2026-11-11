# Customer Support existing media

The support command's final `message` target may select an **existing** attachment
using `message_type: image | video | audio | document`, a public HTTPS `media_url`,
and optional `mime_type`. `content` is the caption and may be empty for media-only
replies. Plain text targets use `message_type: text` and empty media fields.
These empty schema defaults are normalized away before delivery validation.

`response_format: text | audio` is independent: `audio` requests later speech
synthesis from the saved script, not an existing audio attachment. Existing audio
uses `message_type: audio` and `response_format: text`. Any explicit attachment
combined with synthesized audio fails validation; it never silently becomes text.

Only the selected assistant response owns its media metadata. Tool output,
conversation targets and discarded messages cannot supply an attachment to a
different response. Nested targets are treated atomically, without borrowing URL
or MIME fields from an outer result.

Before assistant persistence, the shared outbound-media validator checks shape,
channel compatibility, HTTPS without URL credentials, MIME compatibility and
public DNS. The normalized fields are saved in assistant `custom_data` alongside
`response_format` and approval status, and returned both at `data` and
`data.messages.assistant`. Zavu retries reject changes to saved type, URL, MIME
or speech format instead of overwriting the original response. Public comments
and unsupported channel/type combinations fail closed.

Support generation does not synthesize, upload, fetch attachment bytes or send
messages. Validation resolves DNS only. It does not prove that the URL's content
exists, matches its claimed MIME, meets provider size limits or remains public
at delivery time; the delivery adapter must revalidate it.

## External workflow limitations

Persistence and an HTTP success are not provider acceptance or delivery. External
Temporal workers must forward all three media fields from the saved assistant
metadata/returned result to the appropriate channel send endpoint after approval.
The sibling worker source has been updated. These forwarding changes must be deployed to the Temporal
workers before attachment delivery works end to end; the API cannot update
already-running workers. Exact-delivery/recovery paths must also preserve this
metadata rather than assuming every saved response is text or synthesized speech.
This support change does not modify deployed workers, add public-comment
attachments, or create closed-window
WhatsApp media templates. Provider capabilities, response-window restrictions,
asset access/expiry, limits and delivery receipts remain downstream concerns.

Tests are offline with mocked DNS and persistence; no external writes are made.