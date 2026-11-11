# First-contact WhatsApp automation snooze

## Incident and invariant

On 2026-11-11, an app-origin human message arrived before the customer's first
inbound and before a conversation existed. The old echo handler retried with
`ZAVU_APP_ECHO_CONVERSATION_NOT_READY`. The first inbound then created the thread
and generated an assistant response before the echo retry activated its pause.
The UI showed the original provider timestamp, not the later persistence time.

An accepted, durably registered human event must not depend on another provider
retry to suppress that contact's first automatic reply.

## Protocol

1. Signature verification and exact sender/site/connection validation remain at
   the webhook boundary. Only WhatsApp business-app outbound events participate.
2. `register_conversation_human_event` records the human event even without a
   conversation. Its identity includes tenant schema, site, connection, sender,
   full canonical international recipient and stable provider-message identity.
   Canonicalization removes only `whatsapp:` and an optional `+`; country digits
   are not rewritten and phone suffixes never authorize a match.
   The inbound resolver uses the same four exact representations, reuses one
   existing conversation, and rejects ambiguity before creating another thread.
3. Registration freezes the applicable duration, preserves original event time,
   and records receipt/application times separately. An unbound contact uses the
   site policy; an exactly identified existing conversation uses its lead policy.
   Later settings changes do not retroactively recalculate these events.
4. After saving a WhatsApp inbound, the support route calls
   `reconcile_conversation_human_events` **before context/model work**. This binds
   the contact to the verified saved inbound and materializes pending human
   messages and pauses in one database transaction.
5. Registration and reconciliation serialize on the same contact lock. Once
   bound, a new human event applies immediately. Existing before-generation,
   after-generation, and API/worker pre-send checks continue to enforce the
   persisted conversation policy; no new Temporal workflow or sleep is needed.
6. Reconciliation failures abort processing. They never mean “not paused”.
   A paused inbound uses the existing terminal `agent_snoozed` response and is
   never replayed on expiry. Applied event receipts prevent duplicate rearming
   after manual resume. No agents, delegates or commercial status are reassigned.

No speculative conversation/lead is created by an outbound-only webhook. No
event recovery or historical backfill is run automatically by this change.

Deleting a conversation clears its contact binding without replaying consumed
human events if a new thread is created. Deleting a site cascades its contact and
event records, including pending message content; no orphan contact ledger is
retained across site deletion. These records are server-only with RLS enabled.

## Limits

A webhook not yet received and committed cannot be known by a send guard. A
provider send already accepted cannot be recalled. The database transaction does
not extend across model generation or the external provider HTTP call. Historical
timestamps and current pause badges alone do not prove a pause existed at send time.

## Rollout

This document describes implementation, not confirmation of a production rollout.

1. Run offline and isolated PostgreSQL regressions below.
2. Apply `20261111220000_first_contact_whatsapp_snooze.sql` before deploying API readers.
   Deploy the corresponding canonical/bootstrap migration for provisioned schemas.
   Keep existing conversation snooze migrations unchanged. The migration adds an
   index to `messages` with normal PostgreSQL DDL locking; apply in an appropriate
   deployment window rather than assuming a lock-free index build.
3. Deploy the API webhook registration and inbound reconciliation together. Old
   workers retain the conversation guard contract and need no workflow change.
   Missing RPCs deliberately fail closed; do not deploy API before the migration.
4. Verify a controlled contact with no previous inbound: human first, then inbound,
   original timestamp retained, human messages materialized, terminal skip, zero
   generated assistant replies and zero provider sends. Verify an existing contact,
   expiry, duplicates and manual resume too.
5. Inspect pending/applied event timestamps and webhook failures. Recovery of
   previously failed production events requires a separate scoped review; do not
   replay all provider events or resend customer messages.

Rollback must not simply restore the old echo handler and reopen the original
race. Preserve the additive data and fail-closed checks, or explicitly stop affected
automatic sends while repairing. Do not delete pending events to clear failures.

## Validation commands (from the API repository)

```sh
node node_modules/jest/bin/jest.js --config jest.snooze-contact.config.js --runInBand
node node_modules/jest/bin/jest.js --config jest.support-response.config.js --runInBand
node node_modules/jest/bin/jest.js --config jest.automation-send.config.mjs --runInBand
node --test __tests__/whatsapp-snooze-policy-integration.test.mjs
node --test __tests__/first-contact-whatsapp-snooze-sql.test.mjs
node --test __tests__/first-contact-snooze-postgres.test.mjs
```

The last test must run against a disposable local PostgreSQL cluster, never the
production database. PGlite sequential tests alone do not establish multiconnection
locking behavior. All fixtures must be synthetic and send no customer messages.

## Local verification (2026-11-11)

- Support response suite: 221 tests passed, including canonical recipient aliases
  and first-inbound reconciliation ordering/fail-closed handling.
- Echo/contact helper suite: 97 tests passed.
- API send guards: 16 tests passed; unchanged Workflows snooze suites: 31 passed.
- PGlite predecessor, first-contact and real-handler integration suites: 44 passed.
- Disposable PostgreSQL 17: five subtests passed (six including the parent test),
  with actual observed lock waits, both event orderings, duplicate/resume, deletion
  lifecycle, and anonymous/authenticated access denial. No tests skipped.
- API `tsc --noEmit --incremental false`: exit 0.
- API/canonical/bootstrap migration copies match; bootstrap static validation passed.

No migration, deployment, production replay or customer send was performed by
this implementation session. A read-only PostgREST query validated the canonical
conversation lookup syntax against the existing affected thread.