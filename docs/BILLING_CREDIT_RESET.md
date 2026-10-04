# Non-accumulating plan credit allowances

## Scope and rollout status

These changes target Supabase project `rnjgeloamtszdjplmqxy` (Makinari), shared
by API, market-fit and Workflows. Creating these files does **not** apply them to
Supabase, deploy applications, or restart the Temporal worker.

Apply the forward migrations in order using the approved database-owner workflow:

1. `supabase/migrations/20261003230000_credit_buckets_and_monthly_reset.sql`
2. `supabase/migrations/20261003230001_stripe_plan_credit_reset.sql`
3. `supabase/migrations/20261003230002_classified_credit_operations.sql`

Pause signup/fallback initialization, renewal, subscription webhook and credit
purchase writers during the coordinated rollout. The database rejects legacy
aggregate-only writes and the old unclassified `add_credits(uuid,integer)` RPC;
rolling out only the schema or only the applications will fail closed. Apply the
SQL, deploy API and market-fit, restart/update the Workflows worker, then resume
processing and retry queued deliveries. Do not run the historical additive
renewal backfill. No production build or deployment is included in this change.

## Balances

- `plan_credits_available`: remaining included allowance. It expires at the
  period boundary, and a new eligible period replaces it, never adds to it.
- `purchased_credits_available`: bought credits. They do not expire monthly.
- `legacy_credits_available`: protected historical credits whose origin cannot
  be proven safely, including unclassified restores. They do not expire monthly.
- `credits_available`: compatibility aggregate of the preceding three buckets.
- `account_balance`: separate withdrawable balance. Migration and monthly reset
  never modify it. Existing withdrawal/reservation functions remain unchanged.
- `credits_used`: lifetime usage, retained for audit.
- `monthly_credits_used`: current-period usage, reset once on a new period.
- `plan_credits_used`: included credits consumed in the period, retained across
  plan changes so downgrading and upgrading cannot refill already spent credits.
- `plan_credit_source`: records signup, migration, Toolbox or invoice ownership
  of the period, so a verified subscription can replace signup only once even
  when both begin at the same calendar-month boundary.

Ordinary consumption spends included plan credits first, protected legacy second,
then bought credits. The commerce numeric deduction overload retains its existing
ability to use `account_balance` only after regular credits are exhausted.

## Allowances and periods

| Stored plan | Included monthly credits |
| --- | ---: |
| commission / free / toolbox (Toolbox) | 1 |
| engine / starter | 20 |
| foundry / startup | 100 |
| enterprise | 500 |

Paid plans include five additional credits per addon. Unknown plans have no new
monthly grant and require entitlement reconciliation; no paid amount is guessed.

Non-Stripe renewals use UTC calendar-month periods. A missed worker run grants
only the current period, not every historical month. The daily worker processes
the boundary at its next run; deduction and credit validation also refresh the
period lazily. The database is authoritative for dates and allowance amounts.

Stripe-managed active plans use the verified invoice subscription-line period.
Only a verified paid creation/cycle invoice resets the allowance. Invoice identity
is idempotent and same-period/older deliveries cannot refill spent credits. An
expired paid period loses only its included bucket; purchases and withdrawable
money remain usable while the next invoice is unpaid or delayed.
An inactive or archived account cannot spend an included allowance. Historical
Stripe rows without a proven current period have no included grant until a live
paid invoice establishes that period; the migration does not invent a paid month.

Signup remains a **one-time 30-credit** welcome allowance through the first UTC
calendar-month boundary, followed by Toolbox's one credit per month. All issuers
call `initialize_site_billing`. Existing billing is never topped up just because
its welcome payment marker is missing; consumed signup credits are not replaced.

Actual terminal states `canceled`, `cancelled`, and `incomplete_expired` become
`commission` (Toolbox), with zero addons and one included credit. Replaying the
same cancellation does not refill spent credit. A scheduled cancellation retains
paid entitlement until the subscription actually ends. A terminated Stripe ID
cannot be reactivated by a stale update; a new subscription ID is required.

## Historical migration safety

The migration snapshots balances into the service-only, RLS-enabled
`billing_credit_migration_audit` before changes. It preserves a conservative upper
bound of all completed historical bought credits (capped at available credits),
even if historical spending could have used some of them. This deliberately
favors preserving customer money over claiming an exact historical breakdown.

Unclassified positive movements and saldo above demonstrable plan grants remain
in the protected legacy bucket. Only identifiable included-plan surplus is
expired. The known duplicate signup pattern requires the actual fallback payment
note, zero purchase amount, 30 credited units and a payment created after billing;
it is not inferred from an arbitrary free-plan balance alone.

The four currently canceled accounts identified during read-only inspection are
Bugster, B Venture Capital, Come Bien and Plick. Their included balances become
one credit each when the migration is applied. Makinari's historical 20-credit
purchase remains protected and Pigs' 17.42 withdrawable balance remains intact.
The known 2guia duplicate signup balance is capped from 60 to one credit: its
September signup period has already ended. A duplicated signup within the current
month is capped at 30 until its first monthly boundary. These are intended
migration effects, **not changes already made to production**.

Inspect audit rows with nonzero `protected_unclassified_credits` before deciding
whether any protected legacy funds can be reclassified. Do not zero them blindly.
Do not roll balances back from audit snapshots after new consumption/purchases:
reconcile ledger changes first and use a forward corrective migration.

## Verification

Run API's focused offline suite:

```sh
node node_modules/jest/bin/jest.js --config jest.billing.config.js --runInBand
```

SQL scenarios run in an in-memory PostgreSQL engine using the existing PGlite
dependency, with synthetic accounts and runtime-generated IDs, no environment
loading, no configured Supabase URLs and no credentials. Worker and market-fit
regressions verify producer contracts, invoice periods, retries and cancellation.
After an authorized remote rollout, check grants/RLS, the migration audit,
bucket-sum constraints, cancellation totals, purchased and withdrawable balances,
worker execution and Stripe retry outcomes; run Supabase security advisors.

The concurrency suite additionally creates a disposable socket-only PostgreSQL
cluster using locally installed PostgreSQL 15+ binaries. It fails explicitly if
those binaries are unavailable; it never connects to a developer or remote DB.
It proves both lock orders, including the initializer / ledger foreign-key lock
cycle that requires `FOR NO KEY UPDATE` on the site row.