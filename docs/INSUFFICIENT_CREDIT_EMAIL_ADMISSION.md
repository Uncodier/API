# Insufficient-credit email deduplication and burst limits

The `CreditService` shortage email uses a durable PostgreSQL admission gate
**before** calling the transactional email facade. The previous check of
`notifications` alone allowed concurrent requests to send before any of them
recorded the notification.

## Policy

- At most **one send attempt per site in a rolling 24-hour window**. Different
  blocked operations, required amounts and balances do not bypass this gate.
- At most **three send attempts per normalized recipient in a rolling 10-minute
  window**, including attempts from different sites or owners with the same
  email. The recipient is trimmed/lowercased and SHA-256 hashed before admission;
  the gate stores no email address or message body.
- Admission is atomic across workers. Its state lives in PostgreSQL, not an
  evictable cache or process-local lock.
- Duplicate/rate-limited requests do not dispatch, insert a notification or
  consume another attempt. A denied request is not queued for later delivery.
- Notification read errors, admission RPC errors and malformed admission
  responses suppress sending (fail closed).
- The claim verifies the site still belongs to the owner whose email was
  resolved. An ownership change before admission denies the stale request.

An admitted operation receives a persisted idempotency key passed to
`sendGridService.sendEmail`. Zavu binds this key to its sender, recipient and
payload. SendGrid does not offer the same provider idempotency contract; the
database gate still limits application dispatches with either transport.

## Failure semantics

Once reserved, the attempt remains counted even if the provider fails, times
out, returns an unconfirmed outcome, or the `notifications` insertion fails.
There is deliberately no release or automatic retry: a timeout does not prove
that an email was not accepted. This is an **at-most-once dispatch policy within
the cooldown**, not an exactly-once delivery guarantee. A worker dying after
reservation but before dispatch can suppress that day's email.

Rolling windows count the **reservation timestamp**, not final provider delivery
timestamps. Provider latency or a stalled worker can shift actual sends relative
to that timestamp; this is not a precise delivery-time rate limiter. Admission
still prevents simultaneous blocked operations from starting duplicate sends.

The existing 24-hour notification lookup remains in place to honor notices sent
before the migration. Successful dispatch still records the user-visible
notification, but that write is no longer the concurrency safeguard.

The billing check and deduction contracts are unchanged: insufficient-credit
operations remain blocked regardless of whether their email is sent or
suppressed. No extra recipients are added and the email content is unchanged.

## Deployment and verification

Apply the migration at
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261021230000_insufficient_credit_email_admission.sql`
**before deploying the updated service**. Without the RPC, the new code fails
closed and sends no shortage emails. The admission tables have RLS enabled and
no direct application-role privileges; only `service_role` may execute the
security-definer claim function with its pinned search path.

Run the offline billing regressions from
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```sh
node ./node_modules/jest/bin/jest.js --config /Users/prado/Desktop/Proyectos/Uncodie/Code/API/jest.billing.config.js --runInBand
```

For independent-backend concurrency and restart durability checks, with local
PostgreSQL 15+ binaries installed:

```sh
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/billing/__tests__/insufficient-credit-email-admission.mjs --local-postgres
```

This creates and removes a disposable PostgreSQL cluster with a private Unix
socket and no TCP listener; it never connects to an existing database.

These tests mock provider dispatch and run SQL against isolated local databases;
they do not send real emails or require production credentials.