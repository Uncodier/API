# Customer Support inbound audio

Zavu's documented `message.inbound` contract uses `data.messageType: audio`
and `data.content.mediaId` initially; subsequent GET `/messages/{id}` reads
provide `content.mediaUrl` (https://docs.zavu.dev/guides/receiving-messages/events.md).
The webhook now resolves that exact message only after sender/site/connection
binding and admission. It checks the returned message identity and makes at most
two 1.5-second attempts. No customer records were queried during implementation.
Top-level mediaUrl, media and attachment arrays remain supported.

Current Customer Support context downloads audio through the read_document DNS-pinned
public-network downloader, invokes the existing Azure transcription service, and uses
CreditService's AUDIO_TRANSCRIPTION pricing/validation/deduction. Failures never
supply guessed transcripts. Historical context reads completed cached transcripts
only; it never downloads or bills old notes. Missing history transcripts require text
or a resend. Transcripts are untrusted customer data, not instructions.

## Migration prerequisite (not applied by this change)

Apply `supabase/migrations/20261105200000_customer_support_audio.sql` before use.
It creates a service-role-only cache/claim table in public and existing app tenant
schemas with sites tables. Provision the same table for future tenant schemas.
Without persistence the feature fails closed (no download or charge).

Claims are unique per site and canonical media URL hash, including signed query
parameters but excluding fragments. Completed transcripts are reused on replay.
Claims are deliberately not expired: interrupted, failed or timed-out work may
already have billed. Operators must reconcile such pending claims before resetting
one; do not blindly delete/retry. Changed signed URLs represent new cache identities.
Credits are deducted before provider invocation, consistent with audioToText;
provider failure can therefore consume credits. No automatic refund is added.

## Bounds and limitations

- Current context: at most two unique audio references, 20 MiB accepted aggregate,
  each download capped at 20 MiB/20 seconds; Azure has a 120-second abort timeout.
  Overall waiting is capped at 180 seconds, but already-started provider/billing
  work is not cancelled by that outer deadline. Each transcript is capped at
  12,000 characters. A second download can occur before aggregate size rejection.
- History: at most ten attachment references across history, read-only cache lookup.
- Authenticated Zavu message lookup reuses platform credentials only on the fixed
  Zavu API. These credentials are never forwarded to media URLs.
- The audio downloader supports explicitly server-bound, same-site Twilio account
  credentials with fixed account/media path checks. Customer Support's Zavu path
  does not supply Twilio credentials or guess global credentials. Private Meta,
  encrypted media, or other authenticated URLs without a public Zavu copy fail
  explicitly; arbitrary webhook headers/tokens are never accepted.
- Media not ready within the short lookup window needs a resend/text. No background
  retry job, migration deployment, live-provider test, or historical backfill is included.
