# Instagram DM participant identity

Outstand inbox DMs (`source: outstand_dm`) are separate from post comments
(`source: comment`). `ensureLocalOutstandConversation` now links both new and
previously imported conversations to a real lead before recording a message.

## Identity contract

- Use the conversation's `participantId` (Instagram-scoped sender ID / IGSID),
  scoped by site and Outstand `socialAccountId`.
- Preserve `participantDisplayName`, optional explicit `participantUsername`,
  and `participantProfilePicture` in conversation `custom_data` as
  `participant_display_name`, `participant_username`, `participant_profile_picture`.
  Null, blank and generic placeholder refreshes do not erase known values.
- `participant_identity_status` is `available` when a name or explicit username
  is known, otherwise `unavailable`. A picture alone does not supply a name.
- Never use the publishing account, `metadata.platformAccountId`, an arbitrary
  metadata username, the message content or a numeric participant ID as a name
  or username. A display name is not automatically a social handle.
- A DM IGSID is **not** a public comment author ID. There is deliberately no
  automatic join with comment leads by ID, display name or guessed handle.
  The comment resolver also excludes DM identities from its legacy handle fallback.
  Explicit CRM links already on the same-site conversation are respected without
  stamping a duplicate canonical DM tuple onto a manually linked CRM contact.

## Leads, races and manual edits

Lead identity is stored in `metadata.outstand_dm_participant_id` and
`metadata.outstand_dm_social_account_id`. Queries always include `site_id`.
New lead IDs use UUID v5 over the versioned site/account/IGSID tuple, so the
existing lead primary key prevents duplicate first-seen inserts across workers.
The existing Outstand conversation unique index handles repeated conversation
imports. Conflicts reload; database errors and ambiguous identities do not
fall back to creating another contact. Identity failures are retryable (503
for callers honoring the error's status; the webhook wrapper returns 500).

New contacts use display name, then explicit username, then **Instagram contact**.
Only names still equal to `metadata.outstand_dm_generated_name` are refreshed.
Manual names, explicit CRM links, other networks and unrelated metadata survive.
Conversation titles refresh only when generic or still equal to the integration's
`outstand_generated_title`. Conditional updates protect concurrent manual edits
and profile refreshes. Retry exhaustion fails rather than overwriting a newer row.

Missing provider fields use the canonical lead's latest identity before a cached
conversation value, so a null update from another/older conversation cannot roll
back a recently enriched contact. Raw provider fields and cached fields remain
separate during reconciliation.

No new database migration is required. The post-comment identity namespace remains
separate; this does not repair existing duplicate legacy records.

## Provider limitation and historical records

The [Outstand conversation contract](https://www.outstand.so/docs/get-conversation)
allows null participant name/photo. Read-only live checks of the two reported
conversations found both fields null, no explicit username, and only the owned
platform account in metadata. This change cannot manufacture those missing names;
the UI should use an available linked contact/participant identity, otherwise
**Instagram contact**, not a website visitor or the publishing account.

Normal webhook reconciliation (including `conversation.started`), local message
sync and mark-read reconciliation enrich existing conversations too. This change
does not automatically backfill the database on UI reads or deploy either app.

For a separately authorized historical repair, fetch and authorize each provider
conversation against its site's accounts, then call only
`ensureLocalOutstandConversation(conversation, siteId)`. That function writes
contact/link/identity metadata only: it does not fetch/import/send messages,
invoke support automation, replay webhooks, or change the last-message timestamp
of an existing conversation. Do not reingest messages just to repair identity.

Deploy the API and the companion `market-fit` display change, then verify an
inbound DM with an available participant name and an unnamed DM. Linked names
must remain stable on retries and null provider refreshes. No Temporal workflow
change is needed for this inbox path; LinkedIn handling is unchanged.

## Offline regression tests

Run from the API repository with the existing CommonJS harness:

```sh
node ./node_modules/jest/bin/jest.js --config jest.harness.config.js --runInBand \
  --testMatch '**/outstand/__tests__/inbox*.test.ts' \
  '**/leads/__tests__/outstand-comment-identity.test.ts' \
  '**/outstand/__tests__/process-webhook.test.ts' \
  '**/outstand/conversations/**/__tests__/*.test.ts'
```

The stateful SDK double enforces lead PK/conversation uniqueness, scoped filters,
and conditional writes. Tests cover concurrent first sightings, cross-site and
account isolation, conflicting/missing identity, explicit CRM links, manual and
concurrent edits, placeholder preservation, failed-write retries, and historical
enrichment without touching the messages table or making provider calls.