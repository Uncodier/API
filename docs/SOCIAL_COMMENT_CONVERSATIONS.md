# Social comment conversations

## API contract

Comments use one conversation for the exact tuple:

`site_id + network + publisher_account_id + outstand_post_id + author_id`

`site_id` is the tenant boundary. The author is the social participant, **not**
the CRM owner, team member, or publishing account. `twitter` normalizes to `x`.
DMs (`source: outstand_dm`, `outstand_conversation_id`) remain separate.

Conversation IDs are UUID v5 from a versioned, unambiguous tuple. The existing
primary key handles concurrent first sightings; conflict reloads verify scope.
No date window, active-status filter, lead ID, handle, display name, or chronology
selects a comment conversation. Missing author IDs isolate each comment and omit
the canonical grouping marker; anonymous commenters are never merged by name.

### Ingestion

`POST /api/agents/customerSupport/message` accepts comments only from an internal
service after existing site authorization. Required body: `site_id`, `message`,
`origin` (network), and `custom_data`:

| Field | Meaning |
| --- | --- |
| `source` | Literal `comment` |
| `publisher_account_id` | Owned Outstand social account ID |
| `outstand_post_id` | Outstand post ID, not a platform ID |
| `platform_comment_id` | Exact inbound platform comment/reply ID |
| `author_id` | Stable author identity; optional only for isolated anonymous imports |
| `channel`, `network` | Canonical network; conflicts with origin are rejected |
| `publisher_username` | Owned publishing account username; refreshed from ownership proof |
| `platform_post_id` | Optional platform ID, checked against the owned post target |
| `platform_post_url`, `content_id` | Optional presentation references |
| `parent_comment_id`, `root_comment_id` | Optional source thread ancestry, not the reply destination |
| `author_identity_status` | `available`, `unavailable`, or LinkedIn `resolve_on_read` |
| `author_name`, `author_username`, `social_handle` | Optional non-LinkedIn presentation identity |

The body `origin_message_id` is retained on inbound `custom_data` for worker
claim verification. Legacy `account_username` means **commenter**, never sender.
New comment storage does not copy arbitrary input JSON or resolved LinkedIn
profile fields. Ownership uses the existing live post/account verifier; failures
do not fall back to a username or an organization-wide API key.

Canonical `conversations.custom_data` contains `source: comment`,
`comment_grouping_version: 1`, `channel`, `network`, `publisher_account_id`,
`publisher_username`, `outstand_post_id`, `author_id`, `channel_delivery: true`,
and the optional post/author fields above. `comment_generated_title` identifies
the generated title; manual titles are not overwritten. Unknown-author imports
instead contain `comment_grouping_status: author_unavailable` without version 1.

`post_title` (200 characters) and `post_text` (2,000 characters) come only from
same-site local content whose metadata explicitly references the Outstand post.
`platform_post_url` is optional HTTPS presentation data and is never fetched.
`post_image_url` is reserved/optional; this implementation does not manufacture
an image URL when the confirmed content contract has no image field.

### Proposed AI replies

Inbound and proposed-message IDs are deterministic within the conversation and
platform comment ID. Retries preserve existing proposals and recover partial
inbound saves; they never overwrite a manually edited pending proposal.
Proposals remain `role: assistant`, `custom_data.status: pending` and persist:

- `source: comment` and the same site-bound account/post/network/author dimensions;
- `reply_to_message_id`: exact local inbound `messages.id`;
- `reply_to_comment_id`: that inbound message's `platform_comment_id`.

The existing support response envelope retains
`data.conversation_id`, `data.messages.user.message_id`, and
`data.messages.assistant.message_id`. Conversation-list full-message reads now
include each message's `custom_data`. Summary reads retain conversation metadata.

### Manual replies

`POST /api/agents/chat/intervention` adds `reply_to_message_id: UUID`:

- Required on a new comment reply. The source must be a persisted `role: user`
  comment in the authorized conversation. Grouped conversations must match the
  exact tuple; explicit same-conversation legacy sources are supported.
- Non-comment source messages, DMs, missing/deleted sources and foreign sources
  fail before saving or starting delivery. Legacy incomplete account metadata
  fails closed rather than guessing a publisher.
- Existing `message_id` means retry of the saved team-member message. A supplied
  reply target must equal the saved target; omission reuses it. Existing retry
  content/author/state/CAS checks remain in force.
- The outgoing `custom_data` and response `data.message.custom_data` contain the
  explicit target contract. `message_id` remains the outgoing ID, not the source.

### Delivery and approval

The existing channel-send workflow passes the outgoing `message_id` to
`POST /api/agents/tools/sendChannelMessage`. Comment delivery loads the saved
outgoing message, follows only its exact source ID, validates its scope and
target fields, and verifies live owned post/account metadata. The provider gets
`parent_comment_id = reply_to_comment_id` and `account_username` from the owned
publishing account, **not** the source comment's ancestor or commenter handle.

`comment_delivery_status` is the separate delivery claim/receipt:
`sending`, `unknown`, or `sent`. Compare-and-set permits only one send.
AI proposals must already be `accepted` or claimed as `sending`; pending drafts
cannot be delivered through the channel tool. Manual team replies are explicit
send requests. The delivery claim compares both metadata and saved content so
an edit or approval reversal during ownership checks cannot send the old draft.
`sent` plus `provider_message_id` reuses the receipt. Provider timeout, malformed
success, explicit failure after attempting a send, or receipt-write failure
requires reconciliation; retries never send again automatically. Generic worker
status updates cannot erase that claim. Acceptance is not proof of delivery.

## Historical records and rollout

No API migration, deployment, remote operation, or backfill is performed here.
Existing mixed conversations and message IDs remain unchanged. They must not be
shown as canonical groups. New comments use the new namespace; no read performs
a historical regrouping. Completed worker claims remain completed.

Legacy pending proposals without explicit targets cannot safely be sent. Keep
them pending until an independently authorized repair binds an explicit source,
or compose a new reply against a selected source. Do not infer targets by time,
replay ingestion to repair metadata, delete claims, or move old messages.

Companion Workflows changes must iterate **each owned account**, not the first
account per network, and version account/post-scoped comment claim/checkpoint
identities with Temporal replay compatibility. Existing approval delivery
already forwards the outgoing message ID. The dashboard must consume the
canonical marker and explicit targets; names resolved from LinkedIn remain
on-demand only. Coordinate API/worker/dashboard rollout after review.

Account-scoped polling calls `GET /api/integrations/outstand/posts/[id]/comments`
with `account_id` and `tenant_id`. The route authorizes site access, verifies the
owned post inventory, and derives the exact account's network/username. Conflicting
selectors and duplicate network/username matches fail closed; legacy requests
without `account_id` retain their existing response contract.

## Offline verification

```sh
npm run test:harness -- --testMatch \
  '**/social-comments/__tests__/*.test.ts' \
  '**/customerSupport/__tests__/*.test.ts' \
  '**/channels/__tests__/ChannelSendService.test.ts' \
  '**/intervention/__tests__/*.test.ts' \
  '**/leads/__tests__/outstand-comment-identity.test.ts' \
  '**/outstand/__tests__/inbox*.test.ts'
```

Tests mock all provider/authentication boundaries and use an in-memory SDK
double with primary-key/CAS behavior. No credentials or remote database required.
The account-selector route uses the ESM test runner:

```sh
npm test -- --runInBand --runTestsByPath 'src/app/api/integrations/outstand/posts/[id]/comments/__tests__/route.test.ts'
```