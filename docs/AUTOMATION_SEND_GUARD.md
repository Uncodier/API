# Automatic conversation dispatch guard

The API rechecks persisted conversation state immediately before supported
provider dispatches. This is a second check after Workflows preflight, not a
replacement for it. No migration or production operation is performed by these
changes.

## Rules and response contract

- Service-role reads use `NEXT_PUBLIC_APPS_TENANT_SCHEMA`, then `NEXT_PUBLIC_SUPABASE_SCHEMA`, then
  `public`. Conversations are constrained by both conversation ID and site ID;
  message-only requests resolve their conversation through a tenant-filtered join.
- An automatic response is suppressed while `automation_paused_until` is in the
  future, or when `last_human_reply_at >= custom_data.automation_started_at`
  (falling back to the saved message's `created_at`).
- Only a stored `team_member` message with matching ID, conversation and exact
  content bypasses this check. Caller role/actor flags are not consulted.
  Tracked voice uses the supplied greeting, or objective when there is no
  greeting, for this exact saved-content comparison.
- Suppression preserves other message metadata and writes `status: skipped`,
  `automation_skipped: true`, `automation_skip_reason` and
  `automation_skipped_at` using compare-and-set. Lost ownership/database errors
  fail closed. Existing sent receipts are not rewritten.
- A persisted `automation_skipped` marker remains terminal after pause expiry.
- The HTTP response is **200**, with the flat body
  `{success: true, status: 'skipped', skipped: true, delivered: false, reason}`.
  Reasons are `agent_snoozed` or `stale_automatic_reply`. Workflows must inspect
  `skipped` before provider receipt validation, sent/task updates or retry logic.

## Covered dispatch boundaries

- `sendChannelMessage`: Zavu text/implicit audio, explicit audio, Instagram DM,
  and saved public comment replies. The route exits before sent metadata writes.
- `sendWhatsApp`: legacy Twilio text/audio and template-required decisions.
- `sendEmail`: original saved message identity passes through merge/signature
  preparation to SMTP and AgentMail dispatch. Suppression cannot trigger SMTP
  fallback; SMTP suppression releases the rate-limit permit.
- `whatsapp/sendTemplate`: check before approval processing and again inside
  template delivery immediately before Twilio POST.
- Saved explicit audio: check before preparation and again after TTS/upload;
  suppression is not rewritten as failed or placement-unknown.
- Zavu audio-to-template fallback: check on each invocation and after approval
  polling before dispatch. A pending template cannot escape a terminal skip.
- `sendExactDelivery`, `sendOutreachMessage`, and tracked `placeVoiceCall`:
  persisted-identity preflight and dispatch checks; exact receipts do not turn
  success/skipped into sent. Outreach releases the reservation on suppression.

## Boundaries and known limitations

- The legacy `/api/agents/whatsapp/send` named by older workers does **not** exist
  in this API tree. `/api/integrations/whatsapp/send` is a different old Cloud API
  path without a site-scoped request contract; it is **not covered** by this
  change. Do not route automatic conversation replies there.
- Requests without either a saved message ID or conversation ID cannot be
  related to a snooze and remain outside this guard (for example standalone
  campaigns, setup tests, and notifications). No caller actor flag fixes this.
- Legacy requests with only a conversation ID enforce an active pause but have
  no trustworthy generation timestamp; stale-generation suppression requires a
  saved message. They never receive a human-role bypass.
- Gear-specific direct/custom Twilio paths have their own project/session
  admission logic and are not retrofitted here. Unsupported channel adapters or
  provider calls bypassing these services are not claimed as covered.
- This is a last-mile database read, not an atomic transaction spanning the DB
  and an external provider. A human reply after the final read can still race
  the network request; already accepted provider messages cannot be recalled.

## Offline verification

`node node_modules/jest/bin/jest.js --config jest.automation-send.config.mjs --runInBand`

The focused suites exercise tenant constraints, exact persisted human identity,
generation-time staleness, terminal retries, compare-and-set loss, HTTP skip
propagation, and human replies during long-audio/TTS/template approval preparation.
They use mocked database/provider boundaries and reserved test hosts, not live
credentials or production services.