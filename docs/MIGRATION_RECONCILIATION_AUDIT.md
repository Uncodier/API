# Makinari migration reconciliation audit

## Result — 2026-10-22

This is a complete **inventory audit**, not a certification that every historical
data migration ran. The audit inspected all 287 original SQL files in the API
(155) and web (132) repositories, against a read-only catalog snapshot of Makinari
project `rnjgeloamtszdjplmqxy`. It also reviewed later body rewrites, renamed
functions, location-ACL wrappers and retired overloads instead of treating them
as missing installations.

The per-file inventory, source SHA-256, applicability, postcondition status and
remaining blockers are in [MIGRATION_RECONCILIATION_AUDIT.json](MIGRATION_RECONCILIATION_AUDIT.json).
Large private catalog/body/effect evidence remains in
`/tmp/makinari-migration-audit/`; it is not committed customer data or durable
monitoring. Repository JSON contains only sanitized migration/object evidence.

### Applied new forward corrections

| Repository | Migration | Correction |
| --- | --- | --- |
| Web | `20261022032027_complete_channel_activation_and_paid_coverage.sql` | Missing manual-channel capability table/RPC; latest paid-coverage inputs in license reconciliation. |
| API | `20261022032532_complete_unused_reconciliation_resume.sql` | Obsolete two-argument resume RPC and missing evidence column; current three-argument contract. |
| API | `20261022032913_restore_legacy_context_usage_acl.sql` | Legacy metrics overload incorrectly executable by PUBLIC/anon/authenticated; restored service-only execution. |
| API | `20261022033613_bound_audited_vector_search_paths.sql` | Converged four record/context-vector search paths while preserving their current invoker bodies, grants and caller RLS. |

All four are recorded in the remote history under the same local filenames.
Every correction checked the inspected baseline bodies/configuration/permissions
and rejected incompatible or partially installed states. No historical SQL was
replayed. The resume table contained zero receipts: no old evidence was invented,
no requirement was resumed and no backfill or payment/provider action was run.
The licensed-channel migration did not alter existing billing/settings data.
The metrics and vector-path migrations did not change their function bodies.

### Verified migration-history repair

The remote history grew from nine to **30** entries: four new forward corrections
and **17 verified metadata repairs**. The latter are 16 function-only migrations
and `20260904173800_records_summary.sql`.

Function-only repairs were limited to valid, unique 14-digit versions whose
complete effects were verified: exact current `pg_get_functiondef`, owner and
ACL, including defaults/configuration and audited superseding definitions.
These checks and metadata inserts occurred in the same guarded transaction.
`records.summary` was verified as the declared text column. Source SQL was stored
in history as text, **never executed** by the repair transaction.

Versions with different files sharing a timestamp, dynamic DDL not fully proved,
unknown backfills or mismatched targets were not marked applied.

## What is still not certified

1. There are **12 duplicate version groups** across/between the repositories.
   Three contain identical SQL; nine contain different SQL. The two date-only
   `20260811_*` files also share an invalid deployment timestamp. A version-only
   history repair cannot identify which distinct file was installed.
2. Historical bootstrap/march schema dumps do not establish that all later data
   cleanups/backfills ran. Time-relative telemetry deletion is particularly
   unsafe to replay: it would delete today's evidence, not prove old execution.
3. Many dynamic RLS/trigger/backfill contracts remain partially verified. Missing
   history is not proof of absence; matching names is not proof of completion.
4. Nine files have a different **Apps** target; one additional file needs target
   confirmation. They were not applied to Makinari. This audit does not certify
   the Apps project's migration state.
5. Existing security-advisor findings outside these corrections remain separate
   work. Owner-only capability/backup tables intentionally have RLS with no
   browser policies; adding permissive policies would be a security regression.
   See [Supabase linter guidance](https://supabase.com/docs/guides/database/database-linter).

**Do not run an indiscriminate `supabase db push`.** First establish a canonical
per-project migration source and explicit mapping of existing duplicate versions.
Keep applied files immutable; do not renumber old history or infer old data
effects. Complete the named residual postcondition checks before any additional
history repair or recovery migration.

## Offline verification

The read-only source auditor does not connect to a database or repair history:

```bash
node scripts/migration-audit/audit.cjs /tmp/makinari-migration-audit /tmp/makinari-migration-audit/source-analysis.json /Users/prado/Desktop/Proyectos/Uncodie/Code/API /Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit
NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js --config scripts/migration-audit/jest.config.cjs --runInBand
```

The audit tests use synthetic in-memory PostgreSQL. Web correction tests use a
new socket-only PostgreSQL 17 cluster. No test calls production. Baseline hashes
are calibrated only for synthetic fixture formatting; production files retain
their inspected raw fingerprints. The original manual-channel and paid-coverage
security suites passed 28 cases; forward guard tests passed four; the audit,
resume, ACL and vector tests passed 12 cases.