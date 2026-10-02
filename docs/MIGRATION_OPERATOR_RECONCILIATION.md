# Operator recovery after a missing-plan migration hold

This is a narrow recovery for an **unapplied** migration whose historical hold
reason was `A pending migration has no requirement-bound implementation plan;
technical review is required.` A new requirement-bound sandbox plan now exists,
but the canonical specification changed after the old review. This is **not** a
general release button, automatic repair, or an agent permission.

## Owners and deployment

The Makinari backend team implements/reviews this capability. A deployment
operator with migration privileges on **Makinari**, not Apps, applies:

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261002010000_migration_operator_reconciliation.sql`

Then apply the forward convergence migration:

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261002020000_migration_reconciliation_fresh_resume.sql`

An **unrecorded draft was observed concurrently in production** during final
verification: receipt tables exist, but resume has only two arguments and lacks
the fresh-evidence column. Do not re-run CREATE TABLE against that installation.
A deployment operator must verify its installed definitions and migration history,
apply the forward convergence migration to that draft, and reconcile migration
history through the normal release tooling. The forward migration removes the
obsolete overload and reinstalls the final guarded functions. It refuses used
draft resume receipts without evidence rather than inventing historical facts.

Then deploy the API through the normal release process. Do not paste only the
UPDATE statement into a SQL editor or alter the existing lifecycle migration.
There is no historical backfill. Deploying this change does not resume anything.
The old application, diagnostic and validation paths keep comparing the active
specification binding; none of those safety comparisons are disabled.

## Guarantees and limits

- The service-only `reconcile_requirement_migration` operation locks and checks
  requirement/owner/plan/step, lifecycle version, execution generation, backlog
  revision and canonical specification. The host first checks the Apps tenant,
  the authoritative receipt lookup, identity capability manifest and exact
  sandbox SQL bytes. It rejects source/specification that the diagnostic would
  redact, avoiding consumption of the single allowance on known missing inputs.
- It atomically archives the **entire prior lifecycle row**, including original
  SQL, old specification checksum and review, along with the current canonical
  specification, operator identity, reason and observed evidence. The receipt is
  append-only and service-read-only; it is never a completion receipt.
- It supersedes only the active specification binding, clears the previous
  review, and sets `correction_required`. It preserves the SQL checksum,
  `original_sql`, and `attempts=5`. The requirement stays **blocked**.
- A database status guard protects that intermediate state: ordinary status
  updates and user-resume calls cannot start work before the explicit operator
  resume has its durable receipt. A failure rolls back admission and its receipt.
- The separate `resume_reconciled_requirement_migration` operation rechecks the
  scope and unchanged reconciliation, admits execution and advances the execution
  generation. It does **not** reset scheduler, step or backlog attempts; it does
  not reopen quarantined work, rewrite a plan, or invoke the generic user-resume
  RPC. The existing cron may subsequently select the requirement. Admission is
  not proof that a worker has started or delivered anything.
- Both operations have immutable request/resume receipts. Repeating an operation
  cannot re-open a later pause or replenish the diagnostic allowance. The CLI
  recognizes the existing request after an uncertain response.
- Only one reconciliation per requirement/file is allowed. The independent
  diagnostic must still be unused. Subsequent correction, central security
  review, atomic Apps application and fresh product/authorization verification
  remain mandatory. The five historical attempts are not five proven repairs.
- Approved/uncertain writes, other migration holds, manual pauses, unrelated
  plans, unavailable evidence, consumed diagnostics and newly changed scope are
  rejected. This intentionally requires a single pending sandbox step and a
  pending runnable backlog item. It is not a recovery for every historical hold.
  The selected step must be the last step and have no stale correction/diagnostic
  assignment or repair-run metadata, matching the existing scheduler's handoff.
  Ordinary downstream dependency blockers remain intact and do not prevent
  running the eligible source item. Other technical/user blockers do.

Makinari and Apps do **not** share a transaction. The database checks a bounded,
fresh **trusted-operator attestation**, not a cryptographic or cross-database proof
of remote state. Never expose these RPCs through model tools or public endpoints.
Drain/quiesce the affected worker and any independent tenant SQL writers before
running the CLI. It checks remote evidence again before explicit resume; normal
application still enforces the immutable Apps ledger. The operator identity is
an audit label supplied by the trusted operator, not a user-authentication claim.
Plan membership is stored partly in JSON; a direct administrative insert on a
different instance is not protected by a requirement foreign key. Quiescing must
also cover plan editors for this requirement. Row locks are not a global writer
fence, and this change deliberately does not table-lock unrelated tenants.
Evidence freshness starts before collection, not after slow I/O finishes. Both
RPCs validate its five-minute age after acquiring locks; resume archives its fresh
attestation as well. An expired observation requires a new collection.

## Operator CLI

Use Node 22 and the already installed `tsx`. The CLI defaults to dry-run, has no
automatic `.env` loading, never prints credentials or raw SQL, and refuses a URL
that does not match the explicitly selected project. Dry-run may briefly resume
the existing named sandbox to read its file and then stop it again; it does not
create a new workspace, apply SQL or update database state.

Provide credentials through your approved environment/secret manager, never CLI
arguments, chat, committed files or logs:

- `SUPABASE_URL` (direct Makinari project URL) and `SUPABASE_SERVICE_ROLE_KEY`.
- `APPS_SUPABASE_URL` and `APPS_SUPABASE_SERVICE_KEY` (the documented
  `REPOSITORY_SUPABASE_*` aliases are also supported).
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` for the **API sandbox
  project**, not the customer app's deployment project.

Create one request UUID and keep it for the operation. For the Crowdrage incident,
the following command uses non-secret identifiers. `REQUEST_ID` and `OPERATOR_ID`
are operator-supplied environment values, not credentials:

```sh
node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/reconcile-requirement-migration.ts \
  --makinari-project=rnjgeloamtszdjplmqxy \
  --apps-project=faxxouxekfwxvexoitxv \
  --requirement=d4049bf8-21bb-48e7-8aa7-869feab35133 \
  --instance=76d2d675-0054-4adc-bcc1-c2717d62fdd8 \
  --plan=4e450100-d6af-4d0c-9365-4029820c35f5 \
  --step=step_1 --file=migrations/0001_initial_schema.sql \
  --request="$REQUEST_ID" --operator="$OPERATOR_ID" \
  --reason='Reconcile missing-plan hold against current specification; ticket 94f385ce-3443-477e-ad65-1c12b241f443.'
```

`--file` is the persisted migration key inside the customer workspace, not a local
path in this API repository. Inspect the dry-run hashes and facts. Run the same
command with `--apply` to reconcile without resuming. After checking the receipt,
run the same command with `--apply --resume` to admit normal execution. Never
make up another request ID after a timeout to force a retry.

The CLI requires the new receipt tables even for dry-run; missing deployment
fails closed. A missing Apps service key or `403` from the migration deployment
API is an access/configuration problem, not permission to bypass the RPC guards.

## Verification and incident notes

Inspect `requirement_migration_reconciliations`,
`requirement_migration_reconciliation_resumes`, the live lifecycle, requirement
and plan, and the scoped `instance_logs` audit events. `harness_inspect` exposes
only bounded reconciliation summaries, not the archived SQL or operator prose.
Verify worker startup and a fresh diagnostic in subsequent logs; do not infer
success from an `in-progress` status alone.

The prior read-only investigation of Crowdrage found a functioning named sandbox,
a file matching the held SQL checksum and no applied receipt/app tables. Its
stale sandbox blocker was already resolved. These historical facts must be
rechecked by the CLI; they are not hardcoded authorization. Do not restore a file
as "previously applied" without an authoritative matching ledger receipt.

Offline validation from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```sh
npm run test:harness
node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/reconcile-requirement-migration.ts --help
```

PGlite tests exercise real SQL guards, RLS/ACLs, atomic rollback, idempotency,
unchanged budgets, explicit resume and the diagnostic/review path. Host tests use
offline clients and synthetic credentials. They do not certify production
multi-connection races, sandbox health, an actual deployment or app delivery.

### Validation and rollout checkpoint

Local Node 22 validation: **163 harness suites / 2,273 tests passed**. Focused
TypeScript diagnostics were zero in the eight changed source/test files. The
repository-wide type check still reports unrelated/generated errors. Next's
`--webpack --experimental-build-mode compile` build completed with existing
dependency/deprecation warnings; this is compilation, not full app delivery.

Deployment was **not performed by this task**: the management API preflight
returned `403`, and the available local environment lacks an Apps service key and
explicit `VERCEL_PROJECT_ID`. Initial inspection returned `PGRST205`; final
inspection found the unrecorded two-argument draft described above, with zero
reconciliation/resume receipts. No worker was resumed. Do not interpret the
local test/build results or the presence of draft tables as production readiness.