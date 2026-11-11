# WhatsApp Business App human replies (Zavu)

## Ingestion contract

The existing signed `POST /api/integrations/zavu/webhook` admits the event through
the durable provider webhook claim before processing. A `message.sent` event with
`data.source = whatsapp_business_app` is dispatched **before** template delivery
reconciliation. It must also have `direction = outbound`, `channel = whatsapp`, a
provider `messageId`, a valid timestamp and text/caption or supported media type.
Ordinary API delivery events retain their existing reconciliation behavior.

The provider's [event reference](https://www.zavu.dev/docs/guides/receiving-messages/events)
explicitly documents this contract. We do not subscribe to the conflicting
`whatsapp.message_echo` name: it is absent from the documented sender-update enum.

Tenant resolution uses an uncached, unique settings owner for the signed sender,
then one WhatsApp connection for that sender. Conflicting sender IDs in an event
are rejected. The handler finds an existing **user** message scoped to site,
connection and sender, using `data.to` as the customer recipient (not `data.from`,
which is the business phone). Only full phone identities with optional `+` and
`whatsapp:` prefixes are equated. Local-number guessing, suffix matching, group
IDs and provider-supplied CRM conversation IDs are not supported. If equivalent
representations resolve to different conversations, the echo is ignored.

No conversation or assignment is created/changed. Missing identity history is a
retryable error, allowing the first inbound workflow time to save its message.
If there never was a matching conversation, provider retries may exhaust; manual
investigation is required rather than guessing a tenant/contact.

The inserted `messages` record uses:

- `role: team_member`, `user_id: null` (never the site owner's ID).
- `custom_data.external_human: true`, `source: whatsapp_business_app`,
  `origin: zavu`, `channel: whatsapp`, `direction: outbound`.
- `external_message_id` and `origin_message_id`: the provider's message ID.
- `connection_id`, `zavu_sender_id`, `zavu_from`: exact resolved identity scope.
- Text/caption, or a media placeholder such as `[audio]`; no untrusted media URLs
  are downloaded by this handler.

The frontend can label this unknown external human “WhatsApp Business App” rather
than falling back to the conversation owner.

## Time, snooze and retries

`created_at` comes from signed `data.providerTimestamp`, then `data.timestamp`,
`data.sentAt`, or the documented event `timestamp`. Seconds, milliseconds and ISO
date strings are accepted. Missing/invalid times are ignored, future times are
clamped to receipt time, and explicit history flags are excluded. Delayed valid
events retain their original timestamp, not the retry time. There is no arbitrary
one-hour cutoff: provider retries can arrive later.

The shared DB human-reply trigger (deployed separately by the snooze workstream)
uses this `created_at` plus the configured snooze duration, so old replies do not
start a fresh pause at ingestion time. It is responsible for monotonic pause
updates and explicit-resume behavior. This handler does not write pause columns.

Durable claims deduplicate a repeated webhook event. A deterministic message
primary key derived from site/connection/sender/provider-message ID additionally
deduplicates different event IDs and concurrent deliveries of the same provider
message. Inserts are never upserts; duplicate messages cannot re-fire the trigger.
Unique violations are checked against the stored identity and content. Database
failures leave the claim retryable; partial completion after insertion is safe.

## Safe subscription reconciliation

Use Node 22+ with the appropriate project's environment loaded. Required values:
`SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, and
`ZAVUDEV_API_KEY`. Never paste credentials into commands or documentation.

```sh
# Read-only default. Environment files must stay untracked.
node --env-file=.env.local scripts/zavu-reconcile-app-echo.mjs

# Only after an operator reviews the dry-run and authorizes provider changes:
node --env-file=.env.local scripts/zavu-reconcile-app-echo.mjs --apply
```

The script pages through `public.settings.channels.connections`, enumerating owned
connected WhatsApp senders. Ambiguous cross-site ownership or multiple WhatsApp
connections are blocked. It reads the actual provider sender configuration and
`GET /senders/{id}/whatsapp-sync` (documented `{sync: {...}}` envelope), not cached
settings metadata. It never requests history/contact synchronization.

Only a missing `message.sent` subscription is proposed. Apply requires confirmed
coexistence, re-reads configuration before mutation and sends **only**
`{webhookEvents: [...existingEvents, 'message.sent']}`. Other events, webhook URL,
signature mode, secret and `active: false` remain untouched. No channel activation,
project-webhook update, secret rotation, settings write or webhook creation occurs.
Already-subscribed senders require no write even when coexistence is unavailable;
the report separately indicates whether coexistence was confirmed.

Apply verifies the provider configuration afterward. Concurrent configuration
edits observed before PATCH block the write. The provider API has no compare-and-set
contract here: run under an operator maintenance window with no concurrent webhook
editors. Verification failures require investigation, not automatic rollback or
reactivation. Secrets are normally omitted by GET, so preservation relies on never
sending a secret mutation; any returned secret is compared in memory only.

Reports contain sender fingerprints, mode, fixed statuses and booleans only.
Provider error bodies, webhook URLs, contact data and credentials are never logged.
No production writes were performed while implementing this feature.

## Offline tests

```sh
node node_modules/jest/bin/jest.js --config jest.zavu-activation.config.js \
  --testMatch '**/whatsapp-app-echo.test.ts' '**/integrations/zavu/webhook/__tests__/route.test.ts' \
  --runInBand
node --test scripts/__tests__/zavu-reconcile-app-echo.test.mjs
```

These cover signed dispatch, ownership/recipient rejection, original event time,
idempotency across event IDs/concurrency, retryable failures, dry-run behavior,
minimal apply payloads, inactive webhook preservation, concurrent changes and
secret-safe output using runtime-generated synthetic credentials.