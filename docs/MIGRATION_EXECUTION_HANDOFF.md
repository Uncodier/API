# Operator-only migration execution handoff

This transfers **legacy execution authority**, not SQL validation or application.
The host CLI is not a model tool, HTTP endpoint, scheduled task, or reset command.
It never executes SQL, grants `validated`, reconstructs SQL from an archive, starts
a worker, or resumes a requirement or sandbox. The requirement remains **blocked**.

## Prerequisites and boundaries

- Deploy the reviewed Makinari SQL migration
  `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261003010000_migration_execution_handoff.sql` and the
  compatible normal execution code through the usual operator deployment process.
  Apps must already expose `apps_get_tenant_capabilities`,
  `apps_get_migration_workspace`, and `apps_record_migration_feedback`.
  This document is not evidence of a live deployment or successful transfer.
- The requirement must be blocked and idle, with no active cron lease, an eligible
  owned instance, and matching requirement/instance/Apps tenant site and user.
  The tenant must be active, with parsed capabilities for the exact schema.
- The legacy row must be `platform_review` or `correction_required`, not approved
  for validation. Active diagnostics, manual plan pauses, unrelated execution
  holds, and unresumed reconciliations prevent transfer. SQL repeats its locked
  admission checks; a dry run cannot promise successful database admission.
- Keep all writers quiescent throughout inspection/apply. The **existing named**
  sandbox must already be running. The CLI uses `Sandbox.get({resume:false})` and
  its current session, avoiding SDK convenience methods that implicitly resume.
  A stopped, missing, or unavailable sandbox fails closed. An operator must resolve
  availability separately through the existing controlled workspace recovery from
  the verified requirement repository/branch. The CLI never creates a replacement
  or recovers SQL from logs. Missing snapshots are not permission to fabricate bytes.
- Supply the canonical migration path under `migrations/`, `supabase/migrations/`,
  `src/db/migrations/`, or `platform/`. Nested paths are supported; traversal,
  non-SQL paths and symlink aliases are rejected. `realpath -e` must equal the exact
  `/vercel/sandbox/<file>` path before and after `readFileToBuffer`.

## Environment only

No `.env` file, Next environment loader, credential file, or automatic project
discovery is used. Provision credentials into the operator process environment
through your secure tooling; do not paste them into commands, docs, logs or chat.

| Scope | Required environment |
| --- | --- |
| Makinari | `SUPABASE_URL` (fallback `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` |
| Apps | `APPS_SUPABASE_URL` (fallback `REPOSITORY_SUPABASE_URL`), `APPS_SUPABASE_SERVICE_KEY` (fallback `REPOSITORY_SUPABASE_SERVICE_ROLE_KEY`) |
| Sandbox | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` |

Both project refs are mandatory CLI arguments, distinct, and exactly 20 lowercase
letters. Each selected URL must be the matching `https://<ref>.supabase.co/`
origin, with no userinfo, additional path, query or fragment. Vercel's project must
own the existing requirement sandbox. Never use a tenant JWT or browser key here.

## Exact CLI usage

Run from the repository root. The quoted variables below are operator-selected
non-secret identifiers; credentials are only inherited from the environment.
Generate and retain one UUID in `HANDOFF_REQUEST_ID` for this operation, and keep
the same request, operator and reason across retries. Do not generate a new UUID
inline every time you run the command.

```bash
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API

# Help: no credentials or network needed.
/opt/homebrew/opt/node@22/bin/node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/transfer-requirement-migration.ts --help

# Dry run: reads only, no pending-feedback writes and no transfer.
/opt/homebrew/opt/node@22/bin/node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/transfer-requirement-migration.ts \
  --makinari-project="$MAKINARI_PROJECT_REF" --apps-project="$APPS_PROJECT_REF" \
  --requirement="$REQUIREMENT_ID" --instance="$INSTANCE_ID" \
  --file="$MIGRATION_FILE" --request="$HANDOFF_REQUEST_ID" \
  --operator="$OPERATOR_ID" --reason="$HANDOFF_REASON"

# Explicit mutation: pending Apps feedback, then audited Makinari transfer.
/opt/homebrew/opt/node@22/bin/node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/transfer-requirement-migration.ts \
  --makinari-project="$MAKINARI_PROJECT_REF" --apps-project="$APPS_PROJECT_REF" \
  --requirement="$REQUIREMENT_ID" --instance="$INSTANCE_ID" \
  --file="$MIGRATION_FILE" --request="$HANDOFF_REQUEST_ID" \
  --operator="$OPERATOR_ID" --reason="$HANDOFF_REASON" --apply
```

Flags require `--name=value`; quote prose. Unsupported and repeated flags fail.
There is **no `--resume`**, `--plan`, `--step`, credential argument, or reset flag.
Operator/reason fields are bounded and reject recognizable credential content.
Do not put SQL or sensitive data in either field. Success output is allowlisted
metadata only; failures omit raw provider errors, arguments, credentials and SQL.

## Evidence and ordering

1. Look up `requirement_migration_execution_handoffs.id = request UUID` before any
   Apps or sandbox I/O. A matching historical identity returns `already_recorded`
   without reapplying, even if the requirement has since resumed or evidence aged.
   A reused UUID for different operation arguments is rejected.
2. Timestamp `observed_at` **before I/O**. Check idle ownership, current bounded
   specification, legacy row version and execution generation. Hash current
   specification UTF-8 and exact sandbox bytes (including BOM/newlines); do not
   reconstruct SQL or require fresh SQL to equal the archived checksum.
3. Read and parse Apps capabilities. Read the full durable Apps workspace and
   refuse any applied receipt for the file key **or the same checksum under a
   renamed key**. Unknown legacy receipt checksums, malformed responses and
   unavailable services fail closed rather than count as absence.
4. On `--apply`, recheck current scope/version/generation/specification, tenant,
   capabilities, workspace fingerprint, bytes and receipt absence. Register
   `apps_record_migration_feedback` with the observed checksum, context
   `operator-handoff:<request UUID>`, and `kind: pending`. This is not an application
   receipt. Dry run stops before this write.
5. Reread the durable workspace and same bindings/bytes after feedback registration.
   Require the pending row's exact key/checksum/context and no applied receipt.
   The feedback RPC's returned row alone is insufficient: it can be synthetic if
   an application raced the call. Evidence must remain at most five minutes old,
   with no future tolerance, before I/O and each mutation; never retimestamp an
   already-collected observation to make it appear fresh.
6. Invoke only:
   `transfer_requirement_migration_execution(p_requirement_id,p_file,p_expected_version,p_expected_execution_generation,p_instance_id,p_request_id,p_operator_id,p_reason,p_evidence)`.
   SQL locks and checks the row CAS, records an append-only handoff receipt, and
   changes lifecycle `state` to `transferred`, `version` to prior + 1. The current
   requirement specification must still match the supplied checksum.

Evidence contains exactly these metadata fields (no SQL, credentials or prose):

```text
observed_at, apps_project_ref, tenant_id, schema, sandbox_name, file,
sql_checksum, receipt_found: false, feedback_registered: true,
feedback_checksum (= sql_checksum), specification_checksum
```

The receipt preserves full prior lifecycle and diagnostic snapshots. SQL archives,
old checksums, reviews, attempts and diagnostic allowances are not reset or
rewritten. Newly edited SQL remains subject to normal tenant/static/history and
application checks. `transferred` must never be presented as SQL applied, tested,
safe, or validated. Only actual Apps application receipts prove application.

## Interrupted operations and operational handoff

The two projects and sandbox cannot participate in a single transaction. A failure
after feedback registration may leave **pending feedback without a transfer**;
do not delete it or fabricate an applied receipt. Quiescence, durable rereads,
freshness and Makinari row CAS reduce races but are not a distributed lock.

After an uncertain RPC response, rerun with the **same request UUID and arguments**.
The receipt lookup reports historical success without another feedback or transfer
write. SQL also enforces request identity/idempotency. If there is no receipt,
resolve the reported operational condition, then recollect fresh evidence with the
same request. Do not change request identity to bypass a conflict or force a retry.

The main operator owns deployment and any later explicit normal requirement
admission/resume. Confirm all other holds and prerequisites through that separate
process. This CLI never resumes, resets counters, starts diagnostics, or requests
SQL execution. Never claim the worker ran based on this transfer's success output.

## Focused offline verification

```bash
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API
/opt/homebrew/opt/node@22/bin/node ./node_modules/jest/bin/jest.js \
  --config jest.harness.config.js --runInBand --runTestsByPath \
  src/app/api/cron/shared/__tests__/migration-execution-handoff.test.ts
```

Tests use mock clients and runtime-generated synthetic credentials on reserved
hosts. They cover scope/capability mismatch, receipt key/checksum renames, exact
bytes, fresh SQL versus archives, dry run, freshness, feedback ordering/durable
races, CAS failure, uncertain-response idempotency, CLI rejection and secret-safe
errors. They do not make production calls or prove live deployment readiness.

## Operational checkpoint — 2026-10-03 UTC

- Compatible API production deployment `dpl_jm8PK5h4P596QqSQYAD4Auq8RucM`
  reached **READY** at 01:11:35 UTC and was assigned the existing production
  domains, including `backend.makinari.com`. Source was deployed from a clean
  staging copy without local environment files; no Git commit/push was made.
- Apps workspace RPC was exercised successfully for all four affected tenants.
- Fábrica de Contenido and NEX CARGO were resumed through the existing service-only
  operator recovery RPC, with system audit logs. Their generations advanced to 16
  and 25 respectively; no applied migration receipt was changed.
- NEX subsequently logged successful migration receipt verification. Fábrica
  reached the product gate and reported a missing workspace file:
  `migrations/20260929222000_content_factory.sql`. Resume is not app delivery.
- The handoff migration deployment attempt against **Makinari** returned HTTP 403.
  It was not applied. No Crowdrage/Visualgv handoff receipt or fake validation was
  created, and their requirements remain blocked.
- Both old named Crowdrage/Visualgv sandboxes exist but cannot resume: the provider
  returns 410, no snapshot available. Recover the verified requirement workspace
  before collecting handoff evidence; do not reconstruct an applied file from prose.
- Local verification: final full harness **174 suites / 2,554 tests passed**,
  including both new handoff suites. Next webpack compile-mode build completed;
  repository-wide TypeScript still reports 202 pre-existing/unrelated diagnostics,
  with none in the changed runtime files. CLI/service strict type checking passed.
- Existing unrelated Supabase security advisories were observed; this operation
  did not modify their permissions. Review them through the
  [Supabase database security advisor](https://supabase.com/docs/guides/database/database-linter).

Required release order: install the new Makinari migration and compatible API,
recover the affected workspace, run the CLI dry-run/apply with fresh evidence,
inspect the private receipt, then explicitly resume the existing owner. The
transfer itself intentionally does not resume a worker or alter product acceptance.