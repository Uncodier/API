# Invoice collection reminders

`POST /api/agents/sales/dueInvoices` is private: API-key middleware requires
`write` scope (or a verified internal service key), and the handler checks
`canAccessSite`. Existing authenticated user sessions remain supported. CORS is
not authentication. Request fields are strict; recipient/content/provider/lead
overrides are rejected.

```json
{
  "site_id": "00000000-0000-4000-8000-000000000001",
  "sale_id": "00000000-0000-4000-8000-000000000002",
  "outreach_activity": "invoices_due",
  "reminder_key": "invoice-due:00000000-0000-4000-8000-000000000002:2026-10-06"
}
```

Response uses the existing agent endpoint envelope:

```json
{ "success": true, "data": { "success": true, "message_id": "uuid", "command_id": "uuid" } }
```

Policy skips return `data.skipped: true` and `reason`; delivery deferrals may
also have `data.success: false`. Generation/database/limiter unavailability is
a failure, not a healthy skip. Invalid requests use 400, unauthorized sites 403,
missing/cross-tenant sales 404. `message_id` identifies the persisted local
message; `command_id` identifies the generation command. A ready retry returns
the same IDs and never generates a second message.

## Configuration and eligibility

Opt-in is `settings.activities.invoices_due.status === "active"`; absence is
disabled. `channel_accounts` uses exactly the existing explicit account map,
including email, WhatsApp and connected `voice` accounts (the UI phone label is
not a new transport/account type). Empty selections never authorize fallback.
`repeat_interval_days` defaults to 3 and must be an integer 1–365; explicit null
is invalid. `daily_message_limit` defaults to 30; weekdays default to Monday–
Friday. Missing invoice timing defaults to business opening (09:00 fallback),
with the existing site timezone/business-hours rules. Lead activity defaults
are unchanged.

Only tenant-scoped, unarchived sites and `sales.status === "pending"` with a
finite positive `amount_due` and valid `due_date <= tenant local today` qualify.
Partial payments retain pending status and positive amount due. Completed,
cancelled, missing-date or future invoices are never reminded. Recipient must
be the sale's existing tenant-scoped lead. Buyer-only sales without this trusted
identity are skipped as `unsupported_recipient`; tenantless profile email is
never trusted and no lead is invented.

Converted/assigned customers are eligible: collections never uses lead segment,
prospecting status, inbound-audience or unanswered restrictions. Quarantine,
unsubscribe, do-not-contact and voice-call opt-outs still apply. The dedicated
CommandFactory/commandService task has no qualification or dispatch tools; it
generates one invoice reminder on an authorized channel, never sales nurturing,
lead reclassification, awareness tasks, invented links or fees. Invoice sends
do not increment the sales-prospecting unanswered counter. Lead-generation and
lead-follow-up logging guards reject `invoices_due`; no generic exemption exists.

## Durable state and final delivery

Forward migration `20261006230000_invoice_reminder_ledger.sql` follows the
financial due-date migration `20261006210000_financial_due_dates.sql`. The API
copy and canonical market-fit copy must be byte-identical and applied **once**
by the normal migration process; this implementation does not apply migrations
remotely or deploy. No existing sale/lead/settings rows are rewritten.

Service-only `invoice_reminders` plus `claim_invoice_reminder` lock the tenant
sale row to serialize generation across different keys, hourly polls and retries.
Interval starts at confirmed `sent_at` (elapsed days); a previously consumed
key never generates again. Generating/uncertain records never expire or release
automatically, prioritizing duplicate prevention after unknown writes/commands.
The existing shared Redis/message CAS ledger remains mandatory for transport
and the activity's daily budget. A durable budget preflight avoids generating
new drafts after the daily cap; final capacity is still atomic at delivery.

Messages persist sale/receipt/key and balance/date/currency fingerprints.
`sendOutreachMessage` loads them, rechecks financial eligibility and latest
repeat interval, settings, selected account, recipient and opt-outs after
preparation, then again immediately before the provider closure. Paid invoices,
archives and stale queued balances/dates cannot dispatch. This is a final
reread, not a transaction with an external provider: payment committing after
the final check can still race a provider call already starting.

Changed financial facts safely cancel only ready messages with no transport
evidence (or a known pretransport blocked marker). The cancellation RPC locks
the message, changes its metadata to cancelled and invalidates concurrent CAS
claims. Confirmed, uncertain, dispatching, unknown markers and provider IDs are
never cleared. Disabled settings defer ready messages until re-enabled rather
than replacing them. Operator reconciliation is required for ambiguous attempts;
do not delete receipts/leases merely because time elapsed.

## Offline verification

```sh
node node_modules/jest/bin/jest.js --config jest.outreach.config.mjs --runInBand
node --experimental-vm-modules node_modules/jest/bin/jest.js src/middleware/__tests__/apiKeyAuth.test.ts --runInBand
node node_modules/typescript/bin/tsc --noEmit
```

The invoice suite includes real offline PGlite PostgreSQL migration execution,
atomic claim/ACL/interval/stale-cancellation regressions, dedicated generation,
endpoint tenant authorization, and payment/configuration/recipient changes
before transport. No external generation, delivery or deployment is performed.