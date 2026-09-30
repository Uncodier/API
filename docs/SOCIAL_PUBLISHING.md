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
unsafe paths, and non-media filenames are rejected. Upload other external media
through the existing approved media-upload flow first. The tool never downloads
arbitrary URLs. Provider availability, codec, duration, dimensions, and account
permission checks still occur downstream; this preflight is not a delivery test.

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
media lookup, compare-and-set conflicts, provider rejection, and ambiguous sends.
The API uses ESM Jest; dependency mocks are installed before dynamic imports.

Provider references: [account identifiers](https://www.outstand.so/docs/getting-started#targeting-accounts)
and [post/media contract](https://www.outstand.so/docs/create-a-post).