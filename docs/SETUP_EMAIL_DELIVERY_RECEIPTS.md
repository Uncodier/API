# Durable setup email delivery receipts

## Boundary and rollout

`POST /api/site/setup/email` is internal-service-only. It independently verifies
the canonical `SERVICE_API_KEY` credential (including header precedence); browser
API keys, sessions and forwarded identity headers do not authorize delivery. It
accepts only the operation key, site UUID, recipient, subject and message. No
caller-supplied actor, tenant, sender or provider state is accepted. The atomic
claim verifies the persisted active site with an owner before the first attempt.
Responses are private/no-store and JSON request bytes are bounded.

Apply `20261007004000_setup_email_delivery_receipts.sql` through the approved
migration process **before** deploying the API and updated worker. This change
does not edit the billing initializer or old migrations. Configure the worker's
server-only `SETUP_EMAIL_SERVICE_API_KEY` to the API's internal `SERVICE_API_KEY`.
Do not expose either value to a browser or workflow history. Missing dedicated
credential skips email. Missing migration/database confirmation fails closed:
no send without a confirmed newly acquired durable claim. Never fall back to the
old unprotected send-email endpoint.

## Retry identity and delivery states

The worker hashes Temporal namespace, workflow ID, run ID, activity ID and site, not
attempt/task token/time. Activity retries keep the same key. A new workflow run
is a distinct operation, not an automatic reconciliation attempt. The database
stores the exact server-built JSONB payload and site against that operation key.
Different recipient, subject, body, signature policy or site is a conflict, not
a resend. Creator/actor hints cannot change this identity.

Only `acquired` calls the existing `sendEmailCore`, preserving real integrations
and provider status/nonempty message ID validation. Setup disables the core's
AgentMail-to-SMTP fallback after an ambiguous provider error. Other email callers
keep their existing behavior. The core send confirmation budget is 60 seconds;
the worker HTTP budget is 120 seconds within the 5-minute activity budget.
Timeout does not cancel an already accepted external send.

- `sent`: persist the actual returned provider ID, recipient and confirmation
  timestamp. Replay returns that receipt before touching core or Redis, even if
  Redis is down. `sent` means provider acceptance, not guaranteed inbox arrival.
- `skipped`: definite pre-delivery configuration/validation/rate rejection or a
  real provider skip. The same operation is never automatically tried again.
- `uncertain`: attempted delivery lacked trustworthy confirmation or final
  receipt persistence confirmation. Report `success: false`, `unconfirmed: true`
  and `skipped: true`; do not label this known non-delivery or completed email.
- `claimed`: another request owns the attempt, or the worker died after claim.
  Return unconfirmed/skipped. There is **no expiration, reclaim or auto resend**.

The table has forced RLS and no browser role grants. Service-role access is
read-only directly; the claim/finalize RPCs are service-role-only, security
definer functions with a fixed search path. Finalization is bound to the original
site, exact payload and private random claim token. Final sent receipts cannot
be overwritten by a different outcome.

## Crash window and manual reconciliation

This is at-most-one application dispatch per operation, **not magical exactly-once
external delivery**. A crash between provider acceptance and final receipt can
leave `claimed` forever. A crash before dispatch can also leave `claimed`. Neither
case proves delivery/non-delivery, and automatic replay must not send again.

An authorized operator can read `setup_email_delivery_receipts` with a service
client, inspect the operation/site/payload/claimed time, and search the configured
provider's sent records plus existing `synced_objects`/message tracking. Do not
log the recipient/body/token to public logs. If independent evidence confirms
provider acceptance and a real nonempty provider message ID, invoke
`finalize_setup_email_delivery` using the row's original key, site, exact payload
and claim token, `p_state: sent`, and `p_receipt` containing `success: true`,
`status: sent`, that actual `messageId`, matching `recipient`, and a real ISO
`sent_at` confirmation timestamp. Claimed or uncertain -> sent is permitted only
through this token-bound RPC; it never authorizes another external send.

If evidence is absent, keep the claim unresolved/uncertain. No reset/delete/reclaim
RPC is provided. An intentional new email is a separate operator decision with a
new workflow/activity operation, outside automatic retries, after reviewing the
duplicate risk. Local tests/source edits neither reconcile production nor send.

## Offline verification

```sh
PATH=/opt/homebrew/bin:$PATH node node_modules/jest/bin/jest.js --config jest.setup-email.config.js --runInBand
PATH=/opt/homebrew/bin:$PATH npx tsc --noEmit --incremental false
```

The focused Jest config is isolated from dirty sandbox/billing configs. Tests
exercise actual route authorization and mocked core delivery, the actual forward
SQL under installed PGlite, and transaction lock blocking on a disposable local
PostgreSQL server with no TCP listeners or inherited connection credentials.
No dependency install, build, remote migration or real provider send is required.