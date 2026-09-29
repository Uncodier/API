# Central automatic outreach delivery

`POST /api/agents/tools/sendOutreachMessage`

```json
{ "site_id": "uuid", "message_id": "uuid" }
```

Uses normal API-tool middleware authentication (write scope), then `canAccessSite` and tenant-scoped message → conversation → lead resolution. Caller-supplied recipients, content, providers, and activity overrides are rejected. The queued assistant message must be `accepted` or `sending`.

Response is a raw object, not a `data` envelope:

```json
{ "success": false, "deferred": true, "reason": "daily_limit", "retryAt": "2026-09-30T06:00:00.000Z" }
```

Deferrals use HTTP 200 and must **not** invalidate recipient/contact information. Successful retries can return `alreadySent: true`. Malformed input uses 400, inaccessible site 403, missing/cross-tenant message 404.

## Policy and generation

Reads current `settings.activities.leads_initial_cold_outreach` or `leads_follow_up`. Explicit activation is required. Empty/missing selected accounts never imply automatic fallback. Segment scope is `leads.segment_id` membership, unless `all_segments === true`. Defaults: daily cap 30 (1–10000), unanswered cap 3 (1–100), follow-up JS weekdays `[2,3,4]`. Timezone: first `business_hours` array entry / object `timezone`, otherwise `America/Mexico_City`, matching Workflows. Invalid timezone/configuration fails closed.

Message provenance is `custom_data.outreach_activity`. Known historical workflow/source/follow-up markers are recognized conservatively. Invalid explicit provenance is not inferred. Managed generation accepts both top-level `outreach_activity` and `additionalData.outreach_activity`, loads the tenant lead instead of trusting `leadData`, validates policy/audience/history, restricts AI to selected channels (including Zavu-only sites), and persists trusted provenance in log messages. Existing interactive generation is unchanged.

Cold outreach requires no authentic user inbound; follow-up requires at least one. Internal/system/outbound records are excluded as replies. Unanswered count includes confirmed assistant sends since the latest user inbound across channels; provider IDs deduplicate tracking copies. Drafts do not count. Reaching the cap defers delivery; marking the lead cold after a reply window belongs to Workflows, not this endpoint.

## Account selection and dispatch

- `channel_accounts` is `Record<string, string[]>`, retaining empty `email` / `whatsapp` defaults. Keys must match `/^[a-z][a-z0-9_-]{0,63}$/`; prototype names and `audio` are rejected. Audio is a message format, not an account/channel.
- All connected unique `channels.connections` entries with matching `type`, a usable raw ID (1–200 characters, trimmed, no controls), and nonblank `zavu_sender_id` are eligible when explicitly selected. This includes SMS, Telegram, Messenger, Instagram, voice and custom safe channel names. Disabled entries, duplicate IDs and wrong-type selections fail closed. Existing legacy account IDs remain supported and cannot authorize another channel.
- Selected connected Zavu raw connection IDs resolve to the exact `zavu_sender_id`, never the generic first-channel lookup. Explicit disabled email-channel metadata vetoes eligibility. `from_address` display metadata is not required.
- Accounts are sorted; `SHA256(lead.id)` distributes leads deterministically. A previously confirmed selected account is sticky while still selected.
- SMTP and AgentMail call explicit provider services; no provider fallback. SMTP credentials are freshly resolved for the selected email, not cached/another token's account. AgentMail preserves central message metadata and uses the existing message for tracking.
- Legacy WhatsApp uses only the selected account's Twilio credentials. `agent_whatsapp` without its own credentials is unavailable. Outside 24 hours, an existing exact matching site/account template with live approved status is required. No template creation, similarity substitution, global MessagingService fallback, number-candidate fallback, or chunking is used. Missing approved template defers. Text over 1500 characters defers. Zavu enforces its provider channel/template requirements itself.

### Recipient helper contract (shared with Workflows)

`src/lib/services/outreach/recipients.ts` exports pure helpers:

```ts
resolveOutreachRecipient({ siteId, lead, channel, conversations? })
// { channel, recipient, source, conversationId? } | undefined
availableOutreachRecipients({ siteId, lead, channels, conversations? })
// Record<string, { channel, recipient, source, conversationId? }>
```

`source` is `lead_email`, `lead_phone`, `social_networks`, `conversation`, or `legacy_origin`. Pass **only server-loaded data**, never caller/model recipient overrides. `loadOutreachConversations(siteId, leadId)` loads paginated tenant/lead-scoped `id,site_id,lead_id,channel,custom_data` records. `selectedOutreachChannels(settings, policy)` exposes connected selected channels. Generation intersects these with the recipient map before any AI call; logging/extraction retains generic keys and never rewrites an inaccessible channel to email.

- Email uses valid `lead.email` only; SMS/WhatsApp/voice require E.164 `lead.phone` (no country-code guessing).
- Other channels first use an actual same-site, same-lead, same-channel conversation with explicit `custom_data.channel_user_id`, `chat_id`, `external_user_id`, `recipient_id`, `recipient`, `user_id`, `username`, `phone` or `phone_number`. Channel-specific `custom_data[channel]` / `custom_data.identities[channel]` records are also supported. Database conversation IDs, provider thread IDs and sender IDs are **not** recipient identities.
- Otherwise, use `lead.social_networks[channel]` as a bounded identity string or an object with the same identity keys (including `id`). Values must match `[a-zA-Z0-9_@.-]{1,128}` without `..`; URLs, whitespace/controls, telephone numbers prefixed with `+`, and cross-channel objects are refused.
- Historical webhook `lead.phone` used as platform ID is accepted only with exact matching `lead.origin`, a valid non-telephone identity and no social-comment ambiguity. No prefix stripping or `+52` corruption recovery is attempted.
- Public comments and Outstand metadata never establish direct Zavu chat reachability. If same-channel comments or lead `social_handle`/`social_network` metadata make a profile ambiguous, a known explicit direct conversation is required; its identity takes precedence.

The send request remains `{site_id,message_id}`. Confirmed responses and central markers include optional `channel` / `recipient` for accurate workflow bookkeeping. Missing/unsafe recipient returns a deferral without fallback or deleting contact data.

### Voice and media

Voice is a call, **never** a generic text send. Generation/dispatch requires the existing `getVoiceCallEligibility`: granted explicit consent with a valid timestamp and no `do_not_call`. `placeTrackedVoiceCall` rechecks the server lead and consented phone and receives new optional `selectedConnectionId` / `selectedSenderId`; both must match one currently connected site-owned voice connection. Existing callers omitting these parameters retain their existing behavior. Calls start only inside the central daily/message/lead reservation, use the existing tracked-call idempotency mechanism, and count one accepted call as one contact attempt. Existing voice metadata, terminal webhook status and transcript/duration fields are retained; ambiguous placement never automatically retries.

Saved `message_type`, `media_url`, `mime_type` and voice guidance survive generation/logging. Explicit image/video/audio/document messages use Zavu `messageType` / `content.mediaUrl` on the exact selected messaging account; SMS media and generic voice media defer. URLs use the existing HTTPS/public-DNS `assertSafeRemoteUrl` validator; this path never fetches media, follows media redirects, or adds a dependency. Zavu still validates channel/provider media capabilities. No new automatic TTS generation or audio account type is introduced.

## Atomic limits, recovery, and operational trade-offs

Uses existing `REDIS_CACHE_URL` or `REDIS_URL` infrastructure; no migrations/deployment dependencies. Missing/unavailable Redis means **no send**. One Lua transaction reserves site/activity/local-day capacity, global message identity, and a per-lead lease across channels. No in-process counter fallback. Counters last three days; message/ambiguous lead leases do not expire automatically.

Before transport, a compare-and-set writes `custom_data.outreach_delivery` with `state: dispatching`, `attempt_id`, `activity`, `account_id`, `local_day`, `timezone`, `started_at`. A durable site/day reservation count seeds Redis after resets and is rechecked after claim. This guards against counter loss without a SQL function. Reservation counting intentionally includes blocked/uncertain attempts and may under-utilize the daily budget; it never refunds an ambiguous send. All writers must preserve this marker. Daily durable count queries are unindexed JSON lookups and may need indexing later for large tenants.

Transport is called once. Confirmed provider identity writes `state: sent`/`sent_at` and finalizes Redis. Any timeout/error/missing provider ID after dispatch retains the durable marker and non-expiring lease: later calls only defer `delivery_uncertain`, not resend. This prioritizes avoiding duplicates over automatic recovery and can block further outreach to that lead until an operator reconciles provider logs. Do not clear a lease solely because time elapsed. Reconcile confirmed sends to sent state; only proven never-delivered attempts can be manually released after checking both DB and Redis. No automatic reconciliation/reset endpoint is provided.

History paginates tenant conversation joins; histories at/above 20,000 rows defer rather than silently undercount. Recipient removal/unsubscribe/assignment/quarantine and inactive/segment/day changes defer without deleting contact data.

## Verification

```sh
node node_modules/jest/bin/jest.js --config jest.outreach.config.mjs --runInBand
```

Offline tests cover policy, mixed-channel concurrent capacity (including SMS/Telegram/voice), message and lead identity, Redis loss/unavailability, conservative ambiguity, exact provider dispatch/no fallback, selected SMTP tokens, Twilio single-message templates, media/voice metadata preservation, generic generation, persistence and route authorization. Related regression suites cover the actual voice-call service’s selected sender and consent enforcement, terminal callbacks, existing channel/audio delivery and safe URL validation. Lua execution is modeled as a serialized atomic command; no local Redis server was available. No external delivery, remote migration, production build, or deployment is performed.