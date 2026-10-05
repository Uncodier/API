# Exact credit accounting precision

## Forward fix

`supabase/migrations/20261005230000_exact_credit_accounting_precision.sql`
removes the legacy `numeric(10,4)` typmods from exactly three columns:

- `billing.credits_available`
- `billing.credits_used`
- `credit_transactions.amount`

Each becomes unconstrained `numeric`, matching classified credit buckets and RPC
arguments. For example, deducting `0.502249` from 96 included credits plus 20
purchased credits must leave **115.497751**, not 115.4978. The existing exact
`billing_credit_buckets_valid` CHECK remains enforced. Usage and transaction
amounts must retain the same precision rather than silently lose conservation.

`billing.account_balance` is already unconstrained `numeric`. Monetary
`payments.amount` remains `numeric(10,2)` and `payments.credits` remains an integer
purchase/invoice entitlement. Neither is the fractional usage ledger.

Warmed PL/pgSQL trigger assignments can retain the old `NEW` record's typmod
after table DDL, confirmed in both PGlite and native PostgreSQL 17. The migration
therefore reasserts the guard function's **existing** `search_path = public,
pg_temp`, invalidating compiled function state without changing its source,
SECURITY DEFINER status, configuration or permissions. No previous migration,
RPC body, financial guard, CHECK, ACL, RLS policy or stored balance is changed.

## Offline verification

From the API repository:

```sh
PATH=/opt/homebrew/bin:$PATH node ./node_modules/jest/bin/jest.js \
  --config jest.billing.config.js --runInBand
```

The fixture starts from the production four-decimal aggregate, lifetime usage
and ledger schema, not an already widened schema. The new PGlite regression
first proves the old CHECK fails and rolls back. It then verifies exact numeric
equality in PostgreSQL for sequential and crossing-bucket fractional deductions,
full exhaustion, purchased/legacy grants, idempotency, fractional monthly expiry,
the account-balance overload and insufficient-credit rollback. It also compares
stored row text, defaults, nullability, constraints, trigger definitions, function
source/configuration/ACLs and table ACL/RLS state before and after migration.

The disposable real-PostgreSQL suite keeps a warmed API-like backend alive while
a separate backend applies the migration, then checks exact deductions and
ledger conservation in that original connection. Its other concurrency/security
cases remain enabled. PGlite alone does not prove multi-session lock behavior.
The native suite requires local PostgreSQL 15+ tools (`initdb`, `pg_ctl`, `psql`),
creates a socket-only `/tmp` cluster with synthetic data, and removes it afterward.
No test loads deployment credentials or contacts a remote database.

## Operator rollout considerations

- This API change does **not** deploy to production. An authorized operator must
  review and apply this forward migration through the approved migration path;
  do not push unrelated pending migrations or bypass permission failures.
- The migration is transactional and uses `SET LOCAL lock_timeout = '5s'`.
  `ALTER TABLE ... TYPE` requires `ACCESS EXCLUSIVE` locks on `billing` and
  `credit_transactions`, held until commit. This can block reads and writes;
  plan a quiet window and inspect long-running transactions/dependent objects.
- Removing a numeric typmod preserves stored values without an explicit cast,
  rounding, reconciliation or reset. PostgreSQL may still revalidate dependent
  constraints or rebuild dependent indexes. Lock timeout limits each lock wait,
  **not** total migration duration; estimate work from table/index sizes.
- If a lock cannot be acquired, roll back and retry in a suitable window. Do not
  drop the exact CHECK, disable guards, or round balances to make migration pass.
- The unchanged guard configuration reassertion invalidates warmed cached trigger
  state; schema reload is notified only when the transaction commits.
- Verify the three columns now have null numeric precision/scale, existing
  aggregate equality still holds, and a fractional classified RPC succeeds in a
  safe verification environment. Historic rounding cannot be reconstructed by
  widening; the migration deliberately leaves all historical values untouched.