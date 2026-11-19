# Withdrawable funds for credit consumption

## Status and scope

This is a coordinated API, market-fit and Workflows repair for the shared
Supabase project `rnjgeloamtszdjplmqxy` (Makinari). Local implementation and
offline tests do **not** apply migrations, deploy applications or restart workers.
The three database migrations were subsequently applied to this target at
**2026-11-19 00:28:11 UTC** using the canonical schema repository's ignored
credentials. Independent verification confirmed their exact-source history and
installed functions; all historical billing/ledger/reservation values were
preserved. No customer debit or provider call was performed. See the
[canonical application evidence](/Users/prado/Desktop/Proyectos/Uncodie/Code/makinari-db-scheme/supabase/validation/20261119_withdrawable_credit_consumption.md).
**API, market-fit and Workflows deployment remains pending.**

The old five-argument `deduct_credits` and model/image admission reservations
checked only `credits_available`, whereas the commerce overload and navigation
widget recognized `account_balance`. A wallet-funded site could therefore see
available funds but fail tools, image/model work and ICP admission.

## Financial contract

- Renew/expire included funds before server-side admission. Consume current trial,
  plan, protected historical and purchased credits, then `account_balance`.
- `credits_available` remains the sum of **regular buckets only**. The wallet stays
  independently withdrawable; never add it to that stored aggregate or convert it
  into purchased credits as an incident workaround.
- Combined availability is regular credits plus the wallet. SQL `NULL` wallet
  means zero; missing/malformed application fields and nonfinite values fail closed.
  A negative wallet offsets available credits; it is not clamped away.
- Application projections sum the finite decimal JSON representations without
  introducing binary addition drift (for example, `0.7 + 0.1` admits `0.8`).
  PostgreSQL numeric remains authoritative; no debit is rounded to cents, and
  precision already lost when parsing JSON numbers cannot be reconstructed.
- Both debit overloads execute one classified debit and append one ledger entry.
  The existing `remaining` JSON field and numeric overload return still mean
  remaining regular credits. The JSON overload additionally returns `account_balance`
  and `total_available`; insufficient `available` includes both sources.
- The debit metadata contains `account_balance_spent` alongside existing source
  amounts. Lifetime/monthly counters include the full charge; plan usage includes
  only the plan portion. No tariffs or currency conversion rates change.
- Model/image receipts add `account_balance_spent` defaulting to zero for existing
  holds. New holds debit the wallet immediately, so reserved funds cannot be
  withdrawn. Unused tail amounts restore the original source, with wallet refunds
  recorded as `account_balance_restored`. Expired plan/trial money never becomes
  cash or new-month credit.
- Preserve duplicate-operation protections, generation identity, uncertain outcome
  holds and pending actual-cost settlement. The generic tool debit does not gain
  a new idempotency key: callers must not retry an ambiguous debit blindly.
- Wallet access does not activate a paid subscription or grant paid-only licenses.
- Existing optional automatic top-up settings still target the regular-credit
  balance. This repair does not change card-charge consent or auto-top-up policy.

## Forward migrations

Apply only these new files, in order, after the shared annual/trial, OpenRouter
model and image-reservation dependencies are installed:

1. `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261118230000_withdrawable_credit_consumption.sql`
2. `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261118230001_withdrawable_credit_reservations.sql`
3. `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261118230002_withdrawable_execution_admission.sql`

The first replaces both debit overloads. The second adds source receipts and
replaces four hold/finish functions, retaining private-function ACLs and RLS.
The third updates sandbox registration, scheduler admission (candidate and locked
recheck), economic pause recovery and read-only command diagnostics. It checks
exact reviewed function-body hashes and preserves all unrelated guards, ACLs,
lock order and timeout configuration. Unexpected schema drift aborts installation.
None of these migrations grants, moves, resets or reclassifies customer funds.
Existing reservation rows gain a zero-valued wallet receipt, not fabricated history.

## Deployment procedure

1. Confirm the target and authorize the coordinated production rollout. Preserve
   unrelated working-tree changes in all three repositories; do not deploy them
   inadvertently with this repair.
2. Check the current function bodies, reservation constraints, grants and shared
   prerequisites. The inspected image/model/payout bodies matched their source
   migrations exactly (trimmed body hashes), not merely migration history.
3. Choose a quiet window and pause affected paid dispatchers during installation.
   The reservation migration takes table locks and validates revised CHECKs. Its
   five-second lock timeout limits waiting, not total constraint-validation time.
4. Apply all three **complete transactional migrations** via the approved database-owner
   migration workflow and record them. Do not run all unrelated pending migrations,
   rerun the bucket bootstrap, or bypass a denied migration operation.
5. Deploy API and market-fit, then update/restart the Workflows worker before
   resuming paid dispatch. Older instances still reject wallet-only accounts.
6. Verify regular-bucket sum constraints, reservation source sums, unchanged
   historical balances and expected service-only/private grants. Run Supabase
   security advisors and investigate findings with the remediation links.
7. Exercise wallet-only and mixed-source usage with an authorized synthetic account;
   verify debit, leftover refund, counters and ledger. Do not charge a customer
   account merely to test deployment. Review stalled workflows separately and
   resume only known pre-dispatch failures, never uncertain provider effects.

After wallet-funded holds exist, **do not roll back to old reservation finish
functions**: those functions cannot restore wallet receipts. If an incident occurs,
pause new dispatch and keep the wallet-aware settlement path while applying a
forward correction. Do not overwrite live balances from an earlier snapshot.

## Offline verification

The API billing suite is environment-free, uses PGlite and temporary socket-only
PostgreSQL clusters, and never calls providers or a remote database:

```sh
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API
PATH=/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH \
  node node_modules/jest/bin/jest.js --config jest.billing.config.js --runInBand
```

New wallet regressions cover exact fractional conservation, wallet-only and mixed
debits, insufficient totals, expired entitlements, historical holds, original-source
refunds, replay/unknown-outcome handling, ledger rollback and actual-cost settlement.
The real PostgreSQL suite races the existing conditional `deduct_balance` payout
against debits and holds using separate connections and observed lock waits.
Frontend and worker admission regressions live in their respective repositories:

```sh
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit
/opt/homebrew/bin/node node_modules/jest/bin/jest.js \
  --config __tests__/billing-admission/jest.offline.config.cjs --runInBand
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/Workflows
/opt/homebrew/bin/node node_modules/jest/bin/jest.js --runInBand \
  tests/spendable-credits.test.ts tests/icp-mining-credit-activities.test.ts \
  tests/icp-dispatch-activities.test.ts tests/icp-dispatch-workflow.test.ts \
  tests/icp-mining-workflow.test.ts
```

## Implementation verification record

- API billing suite: 35 suites / 438 tests passed, including 12 direct consumption
  scenarios, 33 reservation scenarios and 29 native PostgreSQL concurrency checks
  with 26 observed lock waits identifying the blocking transaction.
- Execution admission test replays the original harness SQL guards, then verifies
  wallet-funded scheduler/recovery/diagnostic/sandbox paths, preserved ACLs and
  function configuration, exact reapplication, and atomic rollback on schema drift.
- market-fit focused offline suites: 5 suites / 143 tests passed.
- Workflows focused offline suites: 5 suites / 154 tests passed.
- API TypeScript and Workflows main/worker TypeScript checks passed with no emit.
- market-fit's full TypeScript check is blocked only by the existing unrelated
  `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/__tests__/app/people/people-results-view.test.tsx:55`
  `ByRoleOptions` error (`exact` is not a supported option). It was also verified
  present in HEAD; no unrelated test changes are included in this repair.
- Database rollout: the three migrations and exact-source history committed
  atomically on 2026-11-19, preserving 66 billing rows, 264 image holds, 436 model
  holds and 108,136 credit transactions. Function ACLs/configuration, table RLS,
  triggers and payout behavior were retained; independent verification passed.
- No application deployment, worker restart, paid provider invocation, customer
  debit or historical financial backfill was performed.