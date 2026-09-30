# Social publishing contract

The `publish` tool resolves every social destination against Outstand's live,
site-scoped inventory before writing content or sending a post. The caller must
supply the authenticated execution site; model arguments never select the tenant.

## Accounts

- Call `social_media_accounts` and use the exact returned account IDs.
- Discovery returns a flat, sanitized `data` array with `id`, `network`,
  `username`, and boolean `isActive` fields. Lookup errors are not empty inventory.
- Legacy network selectors are resolved only when one active account matches.
  Exact IDs and usernames take precedence. Missing, inactive, cross-tenant, or
  ambiguous targets reject the whole operation before a content write/send.
- All account-list pages are checked, up to a bounded 20 pages of 100 accounts.
  An incomplete or changing inventory fails closed.
- Outstand accepts opaque account IDs or exact usernames, not network names.
  Returned post targets are compared against every requested ID to detect the
  provider's silently dropped identifiers.

## Media

Use `media_urls` for image/video attachments. For compatibility, recognized
image/video extensions in `urls` become attachments; ordinary links remain text.
Uploaded Outstand `assets` are resolved with `getMedia(id, siteId)` and must be
active, ready, unexpired, and consistent with the requested site when tenant
metadata is present. Posts use `containers[].media: [{url, filename}]`, not IDs.

Direct media URLs must use HTTPS on `media.outstand.so`, or public storage on
`db.makinari.com`/the configured Supabase project, in `assets`,
`generative_images`, or `generative_videos`. Arbitrary remote origins, credentials,
unsafe paths, and non-media filenames are rejected. The tool never downloads
arbitrary URLs. Provider availability, codec, duration, dimensions, and account
permission checks still occur downstream; this preflight is not a delivery test.

### Managed media upload for TikTok

When TikTok is among the selected accounts, `publish` automatically transfers
trusted external media into Outstand before creating the post:

1. Validate all source attachments and download each file with a 64 MiB cap.
2. Request `POST /v1/media/upload` using the filename and verified MIME type.
3. `PUT` the raw bytes to the returned presigned R2 URL, without API credentials.
4. Confirm `POST /v1/media/{id}/confirm` with the byte size.
5. Publish using only the confirmed active `media.outstand.so` URL and filename.

Upload initialization, confirmation, and cached-media lookup are site-scoped.
The batch has a 120-second deadline, downloads are byte-counted while streaming,
and HTTPS sockets use validated DNS results (no DNS check/fetch gap). Redirects,
private IPs, unexpected ports, partial transfers, MIME mismatches, and malformed
provider responses fail closed. No post is sent if any upload fails; the tool
does not fall back to the original storage URL.

Confirmed media receipts are saved in `metadata.outstand_media_uploads` when a
content record exists, without presigned URLs or credentials. Retrying that
content after a confirmed rejection reuses unexpired receipts only after a
site-scoped media lookup. Media already hosted by Outstand is not uploaded again.
Expired receipts trigger a fresh transfer; unavailable/foreign cached assets
fail closed. Upload/checkpoint failure leaves the content unpublished. No remote
asset is deleted automatically, including an orphaned upload after interruption.

### TikTok post mode

`tiktok.postMode` must be explicit whenever TikTok is selected:

- `DIRECT_POST` requires `privacyLevel`, chosen by the creator from their allowed
  options (`PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`,
  or `SELF_ONLY`). The tool validates the enum and Outstand/TikTok enforces account
  eligibility. It never invents privacy or silently falls back to inbox mode.
- `MEDIA_UPLOAD` sends an inbox draft. Results carry `requires_creator_action`
  and cannot promote social content to `published`, even if the provider labels
  its transfer as published. The creator must finish publishing inside TikTok.

The documented Outstand API does not expose a creator-info lookup endpoint.
Do not invent one or claim an enum value was live-verified. If valid visibility
has not been selected, request it before a direct-post attempt. Uploading a file
to Outstand's Media API and selecting TikTok `MEDIA_UPLOAD` are different actions.

## Content and delivery

- Social content is saved as `draft` before sending. A saved draft is not a
  successful social publication. Blog visibility is a separate local action and
  is preserved independently of social delivery.
- A provider `post_id` and `metadata.social_publication` record targeting and
  delivery state. `pending`/`scheduled` means accepted, not published.
- Only explicit per-account `published` status plus a publication timestamp can
  promote social content to `published`. HTTP-200 failure envelopes, missing
  targets, individual platform failures, and unexpected states are not success.
- For existing content, an atomic compare-and-set on ID, site, update timestamp,
  and metadata claims the attempt before sending. A changed record cannot send.
- An accepted or ambiguous attempt blocks another send with that `content_id`.
  Confirmed request rejection leaves a reusable draft. Reuse `content_id` instead
  of creating another record. New calls without `content_id` are new content;
  there is no text-based deduplication.
- A provider timeout or local persistence failure after acceptance never triggers
  an automatic retry. Inspect the existing provider post before recovery.
- Preview mode performs no account/media lookup or posting and explicitly reports
  `connectivity_verified: false`. Existing explicitly requested single-recipient
  audience test sends retain their separate behavior.

Outstand's create response normally contains targeting but not final delivery
status. This change does not add a polling worker or webhook reconciliation.
Accepted content therefore remains a draft with provider metadata until a
confirmed delivery is reconciled; use Outstand post status to verify publication.

## Rollout and validation

Deploy this API together with the web Imprenta account-ID routing change. No
database migration is needed. Deployment and any historical data repair require
separate approval. Existing mislabelled content is not rewritten automatically.
Do not replay a production publish request as a test.

Offline regression tests:

```bash
npm test -- --runInBand src/app/api/agents/tools/publish/__tests__ src/lib/integrations/outstand/__tests__/accounts.test.ts src/app/api/agents/tools/socialMediaAccounts/__tests__ src/app/api/robots/instance/assistant/__tests__/publish-tool-overrides.test.ts
```

The suites mock all persistence/provider effects, including account discovery,
media lookup/upload/confirmation, HTTPS/DNS transfer, compare-and-set conflicts,
provider rejection, and ambiguous sends.
The API uses ESM Jest; dependency mocks are installed before dynamic imports.

Provider references: [account identifiers](https://www.outstand.so/docs/getting-started#targeting-accounts)
and [post/media contract](https://www.outstand.so/docs/create-a-post).