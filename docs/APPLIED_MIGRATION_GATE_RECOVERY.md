# Exact-byte applied-migration recovery in the database gate

## Scope

The owned `applyDatabaseMigrationsStep` enables deterministic source restoration
when an existing migration's SHA-256 differs from its protected Apps ledger
receipt. This is **not** SQL repair, authorization approval, or ledger repair.
Standalone `sandbox_db_migrate` calls still report drift and its expected/current
hashes; they cannot grant themselves restoration authority.

The gate searches an explicitly allowlisted platform copy bound to the
requirement/schema/path, then the local Git history of that exact migration path.
Git discovery is limited to 80 candidate commits, an eight-second search budget,
one-second subprocess limits and a twelve-second outer command timeout. It does
not fetch other repositories or execute checkout, reset, hooks or filters.
Candidates are limited to 64 KiB and round-trippable UTF-8. Comments, BOM, CRLF
and trailing newlines are preserved. Age or SQL equivalence is never evidence.

Before replacement, the host rechecks the original execution owner, current
specification/generation, tenant registry and protected receipt. The filesystem
operation checks the original content and inode, refuses symlinks/hardlinks,
writes a private preimage outside migration discovery, and renames a same-directory
temporary file. Readback, ledger and ownership checks must pass. These checks are
not a distributed lock against arbitrary external filesystem writers.

Applied SQL is skipped after restoration: it is neither re-linted under current
rules nor executed again. Pending files retain the existing central security
review, lint, atomic application and fresh product-validation requirements.
Existing PostgREST exposure/cache reconciliation still runs after verified
application/restoration, but is skipped when restoration itself failed.

## Evidence and persistence

- Gate results and `cron_database_migration_validation` details carry `restored`
  receipts: path, tenant/schema, expected/previous checksum, source and local
  preimage path. SQL and credentials are not logged.
- `restorationFailure` records bounded reasons, both hashes and whether a write
  was attempted. An ambiguous write requires technical review, not blind replay.
  The durable DB gate disables automatic step retries.
- Restorations are separate from pending-SQL repair targets. They propagate to
  normal successful-cycle checkpoints even when `applied` is empty.
- Workspace bytes are verified across sandbox recovery. Every actual push also
  checks **HEAD blob bytes**, including rebase retries; Git attribute normalization
  cannot silently publish different bytes. Clean/no-push returns are checked too.
- Failed database batches still do **not** publish the workspace. A restoration
  cannot make a later SQL failure pass. The private `/tmp` preimage is sandbox-local,
  not durable storage; it may disappear with the sandbox. The original matching
  Git object or packaged copy remains the source for a subsequent owned gate.

## Limits and rollout

This handles content drift, including emptied applied files. It does not enumerate
the entire ledger to restore deleted/renamed files, fetch shallow Git history,
reconstruct missing SQL, or relax existing applied-history protections. If no
matching bounded source is available, the gate stops with technical evidence.
Do not replace a ledger checksum to match the workspace.

The allowlist currently includes the two retained NEX recovery copies. Next output
file tracing packages only these reviewed SQL assets for the cron and workflow
step routes; it does not ship the entire mixed-project migration directory.

Deploy the API through the normal release process. No database migration, key,
permission or RLS change is needed. Existing blocked work is not reopened and
production files are not restored merely by installing this code. Recovery runs
when the existing workflow reaches its owned database gate.

Tests run with the existing offline `npm run test:harness` command. The recovery
suite executes real Git and host-owned Node filesystem scripts in temporary
repositories, with mocked database receipts and no live provider/production I/O.

Validation at implementation: **160 suites / 2,237 tests passed**. `git diff
--check` and `node --check next.config.mjs` passed. Repository-wide TypeScript
reported 203 errors outside the files changed for this task; none were reported
in the changed migration/gate files. This is not a production deployment or a
claim of a live sandbox/database recovery.