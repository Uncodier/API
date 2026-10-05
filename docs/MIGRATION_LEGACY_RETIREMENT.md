# Retire obsolete migration execution holds

This is an explicit operator decision to move historical work into the normal
implementation loop. It is **not** the evidence-backed workspace handoff and
does not assert current SQL bytes, applied-receipt absence or SQL approval.

## Boundaries

- Targets **Makinari**, not Apps. No Apps SQL, migration receipts, RLS or storage
  policies are changed.
- Eligible idle `platform_review` / `correction_required` rows become `transferred`
  with a new private append-only retirement receipt. Their SQL, checksums,
  specification binding, attempts and diagnostic are retained unchanged. Full
  prior lifecycle, diagnostic and requirement metadata are archived.
- Current normal runtime already understands `transferred`. The database guard
  recognizes either a real workspace-handoff receipt or this distinct retirement
  receipt. It never creates fake validation or workspace evidence.
- Active review/diagnostic leases, pending operator reconciliations and unrelated
  execution holds still deny retirement. Requirement owner/site/user, row version
  and execution generation are checked under locks.
- Archived/error owners may have obsolete authority retired without changing the
  owner. Retirement itself never unarchives, resumes or provisions anything.
- The CLI's separate `--resume` only admits existing unarchived owners without
  manual pauses or remaining holds through the installed operator resume RPC.
  That RPC preserves product attempts/quarantine; its normal infrastructure retry
  resets still apply. Failed/blocked plans are not automatically resurrected.
  Admission is not evidence of worker startup or delivery.
- Normal immutable Apps receipt checks, tenant/static SQL policy and product/access
  tests remain mandatory. Legacy Apps receipts without checksums can still block
  SQL execution; do not fabricate their hashes or remove them. This operation
  removes only the Makinari legacy authority, not every unrelated blocker.

## Deployment and operation

Install through the controlled Makinari migration process:

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261005010000_retire_legacy_migration_holds.sql`

Deployment performs no backfill or resume. Keep writers quiescent during the
explicit operation. Credentials are environment-only; the CLI loads no `.env`.
Use the same operator and reason on retry. Request IDs are deterministic per
requirement/file/version/generation, and persisted receipts recover interrupted
admission. Do not change operator/reason to bypass conflicts.

```sh
/opt/homebrew/opt/node@22/bin/node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/retire-legacy-migration-holds.ts \
  --project=rnjgeloamtszdjplmqxy --all \
  --operator="$OPERATOR_ID" --reason="$RETIREMENT_REASON"
```

Dry run lists candidates without writes. Add `--apply` for audited retirement,
and `--apply --resume` for separate eligible-owner admission. Inspect
`requirement_migration_retirements`, live lifecycle/requirement/owner and scoped
`instance_logs` afterwards. Do not interpret a source change as a production reset.

## Local verification

```sh
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API
/opt/homebrew/opt/node@22/bin/node ./node_modules/jest/bin/jest.js \
  --config jest.harness.config.js --runInBand --runTestsByPath \
  src/app/api/cron/shared/__tests__/migration-retirement-sql.test.ts \
  src/app/api/cron/shared/__tests__/migration-execution-handoff-sql.test.ts \
  src/lib/services/apps-platform/__tests__/migration-execution.test.ts
```

PGlite tests exercise real transaction guards, CAS, RLS/ACL, append-only audit,
archived-owner preservation, idempotency and unchanged data/application receipts.
They do not certify production deployment or a live migration execution.

## Rollout checkpoint

The explicit global inventory found two eligible historical rows: Visualgv `0016`
and Crowdrage `0001`. The controlled migration API returned HTTP **403**, so the
migration was **not installed**. The operator apply command then returned
`PGRST202` for both request IDs because the retirement RPC is unavailable:

- Visualgv: `56b7716f-d278-53e8-a355-f68a00b9e29c`.
- Crowdrage: `3a0dcec9-489e-572f-af4a-051a14289986`.

No hold was retired and no worker was resumed. Crowdrage's current owner is
archived; preserve that independent user/archive decision. A migration-authorized
operator must install the migration before the same global command can succeed.
No API deployment is needed for the already-compatible `transferred` runtime.

Local verification: **7 suites / 135 tests passed**, focused CLI strict TypeScript
checking and `git diff --check` passed. No full production build was performed.