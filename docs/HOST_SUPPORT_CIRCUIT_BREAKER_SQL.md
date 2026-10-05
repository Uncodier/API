# Host-only support circuit-breaker SQL rollout

## Required deployment order

Apply `supabase/migrations/20261005020000_harness_support_circuit_breaker.sql`
to the **Makinari requirement database**, not an Apps/tenant database, before
enabling host circuit-breaker callers. This SQL deployment is required; shipping
TypeScript alone does not enforce the new recording contract.

Prerequisites are the existing lifecycle/diagnostic tables, harness decisions
migration `20261001220000`, and its stale-CAS correction `20261003020000`.
The forward migration dynamically patches the existing
`record_harness_diagnostic_decision` RPC. It checks exact replacement anchors and
the original post-correction function-body checksum. Missing prerequisites,
partial patches, or unexpected source changes fail instead of silently replacing
an unfamiliar function. Exact reapplication is safe. If a drift guard fails,
inspect and reconcile the deployed source; do not bypass the guard or edit
historical migrations.

The existing function identity, owner, `SECURITY DEFINER`, empty `search_path`,
and service-role-only execute grants remain unchanged. There is no new RPC,
agent-accessible support action, database role, or direct service insert grant.
SQL does not distinguish a model from host code running with the same service
credentials: removing escalation from model tools and evaluating the policy in
trusted host code remain required parts of rollout. Never expose service
credentials to agents or clients.

## Recording contract

Only a **new** `escalate_support` call gains the required `payload.circuit_breaker`
key. All existing support payload fields remain required; the total payload
limit remains 65,536 bytes. `approve_backlog` and `adapt_backlog` retain their
original payloads and reject the new key.

The proof is a closed structured object, not prose:

| Field | SQL requirement |
| --- | --- |
| `version` | Numeric `1` |
| `execution_generation` | Nonnegative integer matching requirement metadata; missing metadata generation means `0`, malformed generation fails |
| `backlog_revision` | Nonnegative bigint matching the current revision |
| `requirement_updated_at` | Finite timestamp matching the requirement CAS argument |
| `no_runnable_work`, `no_pending_recovery` | Boolean `true` |
| `exhaustion` | 1–100 structured entries |
| `blocked_item_ids` | Array of at most 200 nonblank strings, each at most 512 characters |
| `plan_versions` | Complete explicit linked-plan snapshot, at most 50 entries |
| `migration_versions` | Complete requirement lifecycle snapshot, at most 100 entries |
| `diagnostic_versions` | Complete requirement diagnostic snapshot, at most 100 entries |

The requirement must currently be `blocked`. Each exhaustion entry has exactly
`{kind, target_id, used, limit, receipt_ids}`. Allowed kinds are `repair_attempts`,
`product_attempts`, `verification_attempts`, `infrastructure_attempts`,
`no_progress_cycles`, and `migration_recovery`. `target_id` is a nonblank string
of at most 512 characters. `used` is a nonnegative integer, `limit` a positive
integer, and `used >= limit`; both are bounded by 2,147,483,647. `receipt_ids`
contains at most 100 nonblank strings of at most 512 characters each. These SQL
bounds are structural ceilings, not budget policy; the host may impose stricter
limits. Receipt identifiers are not interpreted as authority in SQL.

Snapshots have exactly these fields:

- Plans: `{id, updated_at}` for **all** same-site plans explicitly linked through
  `metadata.requirement_id`, including other instances, every status, and
  `workflow_template` plans. Legacy instance-only associations are not explicit
  links. Active legacy non-template plans on an associated instance with a
  matching backlog item (or malformed steps) fail closed as ambiguous recovery;
  SQL does not infer their exhaustion. Host runtime filtering must not remove
  explicitly linked templates from the snapshot.
- Lifecycle: `{file, version, state, updated_at}` for every row in
  `requirement_migration_lifecycle` for the requirement.
- Diagnostics: `{file, token, state, updated_at}` for every row in
  `requirement_migration_diagnostics` for the requirement.

All three arrays are required even when empty. Order and timestamp timezone
spelling do not matter, but duplicates, omitted/new rows, changed versions,
tokens, states or timestamps, and over-limit sets fail closed. Preserve database
timestamp precision; converting snapshots through JavaScript `Date` can lose
microseconds and invalidate the CAS.

The SQL layer validates shapes, freshness, and complete snapshots. The host must
still evaluate actual exhaustion, runnable work, and pending recovery from
trusted state before calling the RPC. Neither explanatory prose nor a
model-supplied proof establishes policy eligibility.

## Transaction boundaries and replay

The existing requirement row lock remains the serialization point. For new
support receipts SQL also takes a short `SHARE` table lock on `instance_plans`
with `NOWAIT`, then locks the snapshot rows in deterministic order. The table
lock is necessary because plan linkage lives in JSON metadata: row locks alone
would not fence a new or relinked plan between the snapshot read and insertion
of a ticket. It blocks plan writes across the table until transaction end;
competing writers cause `55P03` rather than waiting for the table lock while
holding the requirement. Keep the RPC transaction short and defer/reload on
contention; do not retry in an unbounded tight loop.

Migration rows lock in the established order: requirement, lifecycle rows,
diagnostic rows. The existing lifecycle/diagnostic writers and foreign keys
serialize absent-row claims with these locks. Snapshot/CAS mismatches use
`PT409`, not retry-prone `40001`. Reload and recompute the policy after a stale
snapshot; never just change tokens on old proof.

Exact semantic request replay still returns the original receipt, including a
historical receipt without proof, after current scope/ownership authorization.
It does not create another ticket or reevaluate old CAS tokens. A **new** legacy
support request without proof fails. Changed payload under the same request ID
remains a request conflict; a different request ID for an already-ticketed
requirement/item snapshot remains a duplicate-ticket conflict.

Recording support changes only the existing receipt table, with delivery state
`pending`. It does not reopen work, reset budgets, release holds, change any
requirement/plan/migration status, start execution, or send email. The original
delivery CAS remains separate. Do not roll back this guard to accommodate an old
model-driven caller; disable that caller instead.

## Offline verification

Run from the repository root:

```sh
node src/app/api/cron/shared/__tests__/harness-support-circuit-breaker-postgres-runner.mjs
npm run test:harness -- --runTestsByPath \
  src/app/api/cron/shared/__tests__/harness-support-circuit-breaker-sql.test.ts \
  src/app/api/cron/shared/__tests__/harness-decisions-sql.test.ts
```

The standalone PGlite runner covers valid/malformed proof, generation/status/CAS
checks, complete snapshots and changes, limits, authoring compatibility, ACLs,
historical/new replay, duplicate tickets, mutation preservation, lock presence,
and migration drift rejection. It uses runtime-generated synthetic UUIDs and no
credentials, application imports, `.env`, network requests, customer SQL or
support delivery. Single-connection PGlite tests verify lock presence and stale
snapshots, **not** production multi-connection concurrency or throughput.