# Tenant migration execution: normal implementation feedback

## Status and scope

This is a source change with offline regression coverage. **No production SQL
has been applied and no API deployment has been performed as part of this work.**
Rollout requires the operator actions below; a passing local test is not evidence
of deployed RPCs, a live tenant migration, or a successful product deployment.

Normal app/site development uses the existing general implementation loop:
write a tenant migration, call `sandbox_db_migrate`, inspect feedback, correct a
never-applied file, and continue testing. It does not create a separate migration
repair plan, require an LLM security-review verdict, or impose a special
five-attempt migration budget. Existing general agent turn, time, cost and
execution-ownership limits still apply. Infrastructure failures are not a reason
to rewrite SQL or weaken authorization.

## One execution authority, two entrypoints

- `sandbox_db_migrate` discovers files through `applyPendingMigrations` and uses
  the currently active sandbox. The applier delegates each pending proposal to
  `executeTenantMigration` in `migration-execution.ts`.
- `POST /api/platform/db/migrations` uses the **same** `executeTenantMigration`.
  Authentication, scope and quota remain in the existing platform wrapper. The
  migration handler requires a requirement-bound caller and verifies that the
  loaded requirement belongs to the API key's site before tenant/receipt work.
  Caller-provided SQL never chooses another tenant or schema. Stable names map to
  `migration:platform/<name>.sql`; adding or omitting the `.sql` suffix does not
  create a second identity.
- Shared execution checks current requirement ownership/generation, active
  tenant/site/user binding, verified tenant capabilities, protected receipt
  history, the existing linter and static non-destructive application boundary.
  Historical unresolved lifecycle holds are still respected. There is no normal
  call to `authorizeMigrationApplication` and no new Makinari migration lifecycle
  row, status transition, or repair assignment.

These deterministic checks are execution safeguards, **not a proof of arbitrary
RLS or business authorization semantics**. Preserve the intended product roles
and shared organization model. Database inspection, ordinary product tests and
role/access tests remain mandatory; do not convert shared access to creator-only
access or loosen policies merely to pass a check.

## Atomicity and durable evidence

The existing `apps_apply_migration` RPC applies **one file atomically**, including
its protected `_meta` checksum receipt. A directory is not one transaction: if
the first file succeeds and the second fails, the first remains applied. The
batch stops at the first failing file. Correct that pending file before retrying;
adding a later file does not make the earlier one pass.

Applied paths and exact SQL bytes, including whitespace and comments, are
immutable. Restore a changed applied file from a trusted exact-byte source; use
a new forward migration for subsequent changes. Never alter a protected receipt
or replay SQL under a new filename to evade history checks. Historical receipts
without a valid checksum fail closed rather than being backfilled from current
workspace bytes.

An RPC response alone is not completion evidence. Shared execution reconciles
against durable exact-checksum receipts, including after transport errors. An
unknown outcome is not reported as a rollback or a success. Do not blindly
replay SQL or assume the whole batch rolled back because a request failed.

After confirming an exact receipt, the shared executor calls the scope-bound
`apps_reload_migration_schema` RPC to send a fixed PostgreSQL `NOTIFY` for schema
reload. There is no Management configuration API call. If reload fails after SQL
commits, the infrastructure diagnostic is `SCHEMA_RELOAD_PENDING` and confirmed
`applied` evidence is preserved: this is not a SQL rollback. Retrying the same
name and exact SQL bytes reconciles the existing receipt and retries reload
without replaying the migration. A successful reload request is not itself proof
that every downstream schema cache has refreshed; normal application checks remain
necessary.

## Observed files and feedback, not another workflow

`public.apps_migration_feedback` lives in **Apps Supabase**, separate from the
Makinari orchestration database. It records canonical file identity, checksum,
context fingerprint and a bounded, redacted diagnostic. It has no workflow
states, attempt counters, LLM verdicts, or SQL payloads. Protected tenant `_meta`
receipts remain the sole authority for application status.

The applier registers the discovered nonempty pending batch before attempting its
first SQL file. Verification also records newly observed files. Combined with
tracked Git paths and protected receipts, these observations prevent deleting,
renaming, or emptying a pending migration from becoming an empty-directory
success. Unresolved platform proposals are visible to completion verification
even though they do not need a matching sandbox file.

An identical deterministic rejection may be returned with
`diagnostic.repeated: true`, without re-executing the same rejected SQL. The cache
is bound to SQL bytes and execution/schema/capability/policy context; changes
invalidate it. Transient infrastructure failures and schema/data-dependent SQL
failures must not become permanent rejections merely because the file is unchanged.

### Caller feedback

The sandbox tool preserves `applied` and, when known, `pending` filenames,
`failureKind`, and `diagnostic` with `file`, `code`, `message`, `kind`, and optional
`repeated` / `rolled_back`. `rolled_back: true` describes the failed atomic file,
not earlier successes. Missing `rolled_back` is not proof of rollback.

A failed tool result has `success: false` and **no success receipt**. Earlier
successful files remain in `applied`. A verified successful batch, including a
verified no-op, retains the existing `database_migration` receipt with
`pending: 0`; an empty `applied` array does not claim new SQL ran. Feedback does not
write a new plan or requirement status; ordinary correction can continue in the
same agent loop within its normal limits.

The platform handler preserves the same detailed core diagnostic and uses 422
for SQL/policy product errors, 409 for product history/pending conflicts, and 503
for infrastructure failures. Binding failures are 403 and malformed requests
are 400. It no longer mislabels unrelated exceptions as an unavailable apply
RPC. Success still returns `applied`, tenant `schema`, SQL `checksum`, and
`warnings: []` (the current linter emits no warnings);
`applied: false` means the exact receipt already existed. The handler no longer
runs a separate linter.

## Completion is verification, not deferred SQL execution

Normal app/site completion uses a read-only **tenant-SQL** gate:
`verifyPendingMigrations` checks actual files, observations and immutable
receipts. It never applies tenant SQL or manufactures an applied receipt after
product tests. It can write observation metadata in the Apps feedback journal,
so “read-only” does **not** mean no database writes of any kind.

Pending product migrations send the implementation step back to ordinary
correction; unavailable infrastructure fails closed. This does not spawn a
special repair agent. Finalization rechecks receipts and cannot treat unresolved,
deleted, empty, or changed migration files as successful delivery. Product/auth
tests are still required after SQL is applied.

The ordinary gate marks actionable feedback so cached validation, materialized
repair, and no-progress gate-only shortcuts cannot starve the next assistant turn.
This only disables a shortcut: it never widens restricted test-repair tools,
resets budgets, or authorizes SQL. Once current workspace/receipt reads succeed,
an earlier transport or privilege diagnostic requests a retry of the unchanged
proposal rather than becoming a permanent infrastructure hold. A current failed
read still uses normal infrastructure handling.

## Historical incidents and rollout

Existing Makinari migration tables and triggers are **retained**, not globally
disabled or dropped. They continue guarding historical lifecycle rows. Normal
app/site execution creates no new lifecycle rows for them. Existing blocked
requirements, quarantines, and migration holds are **not automatically released
or resumed** by this change. Legacy diagnosis, restoration and reconciliation
tools remain incident-recovery tooling only; follow the existing audited
[operator reconciliation procedure](MIGRATION_OPERATOR_RECONCILIATION.md) for
those incidents. Older repair-loop documents describe that historical path,
not a prerequisite for new normal implementation work.

For a verified **unapplied** historical obligation moving to the simplified
executor, use the [operator execution handoff](MIGRATION_EXECUTION_HANDOFF.md).
Its receipt-backed `transferred` state ends only the legacy execution authority;
it is not `validated`. The pending Apps journal entry, immutable applied receipts,
static SQL policy and normal product gates remain mandatory. Ordinary
`correction_required` rows still do not bypass the historical admission guard.

Operator rollout order (not performed here):

1. Verify the isolated Apps tenant bootstrap, atomic migration RPCs and tenant
   capability prerequisites in the intended environment. Do not use a tenant SQL
   apply call as a health probe or batch unrelated pending migrations into rollout.
2. Review and apply
   `supabase/migrations/20261002100000_apps_migration_feedback.sql` to **Apps
   Supabase first**, not Makinari. This same forward migration includes
   `apps_reload_migration_schema`. Verify the feedback/workspace/reload RPC
   bindings and permissions through the normal controlled rollout process.
3. Deploy the API only after those prerequisites are present. Missing or invalid
   journal/capability responses fail closed; there is no legacy privileged SQL
   fallback. A rollback must preserve protected receipts, observations and
   historical holds, not clear them to make the prior code proceed.

## Offline checks

The platform and tool tests mock tenant execution and databases; redaction cases
generate synthetic credentials at runtime on reserved test hosts. They exercise
caller binding, diagnostic forwarding, partial success, repeated feedback beyond
five calls, correction in the same loop, absence of lifecycle writes, and receipt
rules. Core applier/executor and in-memory SQL tests cover the underlying authority.

```sh
node ./node_modules/jest/bin/jest.js --config jest.harness.config.js --runInBand \
  src/lib/services/platform-api/__tests__/migration-handler.test.ts \
  src/app/api/cron/shared/__tests__/migration-tool-feedback.test.ts \
  src/lib/services/apps-platform/__tests__/migration-guidance.test.ts
```

Use Node 22. These tests do not load live database credentials or require a
production connection and do not replace operator rollout verification.

### Local validation checkpoint

Validated with Node 22.22.2:

- Full `npm run test:harness` equivalent: **172 suites / 2,493 tests passed**.
- Next `build --webpack --experimental-build-mode compile`: exit 0, with existing
  dependency/deprecation warnings. This verifies compilation, not production
  migration execution or a complete deployment.
- Repository-wide `tsc --noEmit --incremental false` still reports errors outside
  this change; no diagnostics were reported in the changed migration, integration,
  gate, workflow, or regression-test files. Build success is not a clean global
  type check (the existing Next configuration skips build type errors).
- `git diff --check` passed. No live customer SQL, remote migrations, requirement
  status changes, worker resumes, or production deployment were performed.