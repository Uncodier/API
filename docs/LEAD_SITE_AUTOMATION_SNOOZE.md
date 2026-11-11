# Lead/site snooze forward migration

`20261111040000_lead_site_automation_snooze.sql` was applied to Makinari public at
**2026-11-11 04:00:03 UTC**, independently verified at **04:00:04 UTC**.
Its applied predecessor `20261110230000` is unchanged. Frontend deployment is separate.

## Contract

- AI Activities site default: `settings.activities.conversation_automation_snooze`
  is `{ "status": "default", "hours": 4 }`. `inactive` disables; legacy `active`
  is accepted as enabled. Hours are numeric, positive, at most 168 (fractions allowed).
  Missing key means **ON4**, with no settings save required.
  If the key exists, both fields are required: `{ "status": "default" }` alone
  is malformed at the database boundary, even if a UI normalizer displays 4 hours.
  Writers must persist the complete object. Existing malformed objects need explicit
  correction before ingestion; this forward migration does not normalize customer data.
- Lead options: nullable numeric `leads.automation_snooze_hours`. `NULL` inherits,
  `0` disables, positive values through 168 override the site.
- A visible linked lead must match `conversation.site_id` to supply an override.
  A mismatched lead uses the current site's policy. Visitors use the site policy.
- `conversations.automation_snooze_hours` is deprecated and **ignored**. Existing
  conflicting customer values are retained, not silently copied. Review these with
  customers before rollout; this migration intentionally makes no data decision.
- Configuration affects future human turns only. No expiry recalculation, message
  replay or backfill occurs. `0` does not clear `automation_paused_until`; use explicit
  Resume now. New human turns still advance `last_human_reply_at` when disabled.
- Both app and webhook `team_member` INSERTs automatically invoke the same existing
  trigger. Internal notes/nonhuman roles, message UPDATEs, duplicate IDs and older
  timestamps cannot extend expiry. Assignment/status are untouched.

## Schema and authorization requirements

Each public/app_* schema with chat tables must have the applied predecessor's three
conversation snooze columns, its human INSERT trigger and write-authorization function,
plus `conversations.lead_id`, `leads(id,site_id)`, `settings(site_id,activities jsonb)`.
Missing prerequisites abort instead of silently leaving a tenant on old policy.
New tenant provisioning must replay the canonical/bootstrap copy after its predecessor.

The migration adds the bounded lead column, config validation/authorization triggers,
and replaces the human trigger function. It is repeatable. It grants no table/function
privileges, changes no RLS policies and introduces no security-definer function or RPC.
Lead/site config INSERT/UPDATE requires authenticated `user_can(site_id,'update')`
(both old and new site on UPDATE), or an actual superuser/BYPASSRLS role, in addition
to existing RLS. Malformed settings are rejected at write and read.

Reads are invoker-security and schema-bound. An inaccessible linked lead aborts the
human INSERT. For missing settings, a `row_security=off` probe **does not bypass RLS**:
PostgreSQL errors if policies could filter this read. Only provable absence (for
example privileged ingestion) defaults ON4. Authenticated RLS clients therefore need
a readable settings row, even if the snooze key is missing. Hidden configuration never
silently becomes ON4. Duplicate settings are rejected as ambiguous. A nonnull valid
lead override does not require reading site settings.

## Offline verification

```sh
node --test __tests__/conversation-snooze-sql.test.mjs __tests__/lead-site-snooze-sql.test.mjs
```

Actual in-memory PGlite checks exercise both migrations, hierarchy, default visitors,
schema-local reads, mismatch, fractional values, malformed config, legacy column
ignored, no expiry backfill, disabled watermark updates, resume/duplicate idempotency,
read-only config writes and silently filtered configured rows. No environment files,
network, credentials, live writes or multi-connection contention claims.