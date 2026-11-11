# Conversation automation snooze

## Behavior

- A persisted external `team_member` reply pauses automation on **that conversation**.
- **Default ON for both existing and new conversations**, without a per-account
  opt-in or a settings save. This takes effect once the migration and services are deployed.
- Default: 4 hours. `automation_snooze_hours = NULL` uses the enabled default, `0` explicitly disables,
  and positive values through 168 hours are supported, including fractions.
- Each newer human reply extends the expiry from its event time. Assignment,
  agent, delegate, lead owner, moderation flags and conversation status are unchanged.
- Pending human sends pause immediately to prevent a competing assistant reply.
  If delivery fails, the pause remains until expiry or explicit Resume now.
- Incoming customer messages are retained without generating an assistant message.
  Previously suppressed incoming messages remain terminal on retries after expiry.
- Expiry makes the agent eligible for the **next new** customer message. No timer
  sends old queued answers. Manual resume does not replay suppressed messages.
- Internal notes and nonhuman roles do not start a pause. Historical messages are
  not backfilled. Delayed events retain their original time; duplicates do not extend it.

## Components

1. `supabase/migrations/20261110230000_conversation_automation_snooze.sql` adds the
   state and an atomic, schema-local, invoker-security human-message INSERT trigger.
2. `src/app/api/agents/customerSupport/message/snooze.ts` resolves exact Zavu
   connection/contact history, checks state, and persists terminal inbound-only skips.
   The route checks before context/model work and again after generation.
3. Zavu inputs are persisted before generation so a reply from the business app
   can find the conversation while the first model response is still running.
   Retries retain the original persisted inbound timestamp and use exact scoped
   command/message receipts, not the legacy "any later assistant" duplicate check.
4. Generated replies carry server-owned `custom_data.automation_started_at` so
   send guards can discard answers superseded by a human during generation.
5. The sibling Workflows repository treats snooze as a successful skip, checks
   persisted state before delivery attempts, and propagates terminal skips instead
   of marking messages delivered or sleeping until expiry.
6. The sibling market-fit frontend provides configurable hours, paused-until
   badges, last-human-reply time and compare-and-set Resume now, with authenticated
   RLS-backed server actions and realtime refresh.
7. `src/lib/services/channels/automation-send-guard.ts` enforces persisted state
   again at supported provider boundaries. See [dispatch coverage and limits](./AUTOMATION_SEND_GUARD.md).

## WhatsApp Business App

The signed webhook recognizes `message.sent` with
`data.source = whatsapp_business_app`, `direction = outbound`, `channel = whatsapp`.
It stores an external human message (no invented team member user ID), scoped to
the exact existing sender, connection and recipient. A deterministic message key
deduplicates echoes across different event IDs. Missing conversation history is
retryable; ambiguous identity never guesses or creates a conversation.

Source identifies the **app**, not a named person or proof that an app-side
automation was manually typed. Arbitrary third-party CRM/API outgoing messages
are not classified as human without explicit integration evidence.

Official references:
- https://www.zavu.dev/docs/guides/receiving-messages/events#whatsapp-business-app-echo-coexistence
- https://www.zavu.dev/docs/guides/whatsapp/business-app
- https://www.zavu.dev/docs/openapi.json

The business-app guide also calls the event `whatsapp.message_echo`; OpenAPI does
not list that enum. This implementation uses the detailed `message.sent` contract,
not a speculative subscription. Validate an actual app-origin payload in staging.

## Existing account verification (2026-11-10)

Read-only inventory of Makinari found one connected Zavu WhatsApp connection.
Provider GET and the reconciliation dry run confirmed an active webhook, already
subscribed to `message.sent`, and active coexistence. **No provider update was needed
or performed.** This does not prove the new handler is deployed or a live snooze works.

The reusable reconciliation script defaults to dry run and only adds a missing
subscription with explicit `--apply`; see its dedicated runbook. Do not rotate
secrets, replace existing event subscriptions, or reactivate disabled channels.

## Rollout and limits

Database update: the hardened migration was applied to Makinari public on
2026-11-11 at 00:26:19 UTC and independently verified at 00:26:29 UTC.
It adds authorization for snooze writes; the API/schema/bootstrap copies match.
Application/worker deployment and remaining code-review corrections are still pending.

Apply the reviewed schema migration before deploying readers in API, workers and
frontend; without the new columns guards fail closed. Use the canonical schema
repository's matching migration/bootstrap artifacts for the supported app provisioner.
Do not assume the central Apps project contains per-customer chat tables.

Deploy API + workers + frontend together after fixing the remaining review findings.
The database is prepared on the linked Makinari project; no app/worker deployment was performed.
Verify one real app reply, one Makinari reply, one agent reply, expiry, manual resume,
duplicate webhook and an in-flight model reply before enabling broadly.

An external provider send already accepted cannot be recalled. A database read
and a provider call are not atomic. The post-generation check also does not lock
human INSERT and assistant INSERT together; web-chat realtime can still race in
that final interval. A future transactional save/admission protocol would be needed
for strict serialization. Calls without any conversation/message identity remain
outside conversation snooze; billing/newsletters are not globally muted.

## Offline checks

```sh
node node_modules/jest/bin/jest.js --config jest.support-response.config.js --runInBand
node --test __tests__/conversation-snooze-sql.test.mjs
node --test scripts/__tests__/zavu-reconcile-app-echo.test.mjs
node node_modules/jest/bin/jest.js --config jest.automation-send.config.mjs --runInBand
```

The SQL suite checks actual Postgres-compatible trigger/RLS behavior with PGlite;
serial operation-order tests do not prove multi-connection production isolation.
Provider tests use synthetic values; no customer message is sent by these checks.