# Instance and requirement deletion

## Contract

`POST /api/robots/instance/delete` permanently removes an instance and its
exclusively owned requirements, including their requirement history. The request
must contain only `instance_id` (UUID) and `delete_requirements: true`.

The route authenticates the user bearer itself. Middleware identity headers,
API-key credentials, instance creator identity, and client-supplied site/user IDs
do not authorize this destructive project operation. The user-scoped database
RPCs require owner/admin plus `user_can(site_id, 'delete')` on the instance's
persisted site. Service-role fallback is intentionally unsupported.

## Deletion sequence

1. `get_robot_instance_deletion_scope` derives and authorizes the complete scope.
   Ambiguous, cross-site, shared, or active execution state fails closed before
   provider shutdown or database cleanup.
2. The API stops a supported remote provider when required. A provider failure
   prevents database deletion; an unknown provider must be stopped using its own
   lifecycle before deletion.
3. `delete_robot_instance_with_requirements` compares the expected requirement
   IDs and provider/status snapshot, reauthorizes, locks, and deletes the
   requirements and instance graph in one database transaction.
4. A matching result returns `success: true`, `instance_id`, and
   `deleted_requirement_ids`. There is no unverified success for a no-op delete.

The old `deleteRemoteInstanceChildren` batching helper is not used. Independently
committed log batches followed by a failed parent deletion would lose history
while leaving the instance and requirement behind. Unknown FK failures and
database timeouts must roll back the complete new transaction.

Requirement history remains append-only while its parent requirement exists.
The forward migration allows history removal only as part of parent deletion;
it does not disable triggers, introduce a caller-controlled bypass, grant direct
receipt deletion, or allow mutation of transferred migration evidence.

No other instance, catalog product, campaign, deployed application, Apps tenant
database, or externally published artifact is deleted by this operation. Shared
or legacy ambiguous ownership requires explicit reconciliation rather than an
automatic expansion of the deletion scope.

Instances with assets linked to content/agents, cross-instance workflow links,
enabled workflow triggers, running actions/nodes/plans, or unresolved execution
leases are rejected. Stop active work and disable scheduling first. Old sandbox
IDs in historical status rows alone do not indicate active execution; historical
provider resources are not automatically destroyed using those old IDs.

Requirement-owned history means the requirement status, plan/log graph and
diagnostic/migration receipts covered by the database ownership relationships.
Separate platform accounting/audit/tracking records and Apps migration ledgers
are not erased. Platform-issued credentials for the deleted requirements are
revoked; user-managed and unrelated project keys remain unchanged. Existing API
key validation caches can remain valid for up to their 60-second TTL, and already
authorized external effects are not undone by credential revocation.

## External and concurrency boundaries

Provider shutdown cannot participate in the PostgreSQL transaction. If shutdown
succeeds and deletion fails, the instance may be stopped with its database data
intact. If an HTTP response is lost after commit, the caller cannot infer that
deletion failed. Neither route nor UI automatically replays deletion; inspect the
instance list before retrying.

Database ownership/binding guards prevent new associated records from silently
attaching to a removed instance or requirement. These guards do not undo already
dispatched external effects. Active execution must be stopped before permanent
deletion. Large histories still depend on the database's existing indexes and
statement timeout; no global timeout setting is changed here.

## Failure diagnosis

The route logs the failing stage (`authentication`, `request_validation`,
`preflight`, `provider_stop`, `database_deletion`, or `receipt_validation`), its
public error code/status, and a validated SQLSTATE/PostgREST code when available.
Raw errors, SQL/provider payloads, credentials, and resource IDs are not logged.
These diagnostics require deployment before new requests produce them. They do
not change deletion authorization, retry behavior, or the database transaction.

The matching web proxy recognizes only allowlisted error code/status pairs and
maps them to fixed messages; unknown or lost responses remain unconfirmed. A
generic HTTP 502 in the browser is not evidence of the underlying SQL error or
whether a transaction committed. Inspect the instance before any manual retry.

## Rollout

The new forward migrations target **Makinari**, never the separate Apps database:

1. `supabase/migrations/20261003180000_robot_instance_requirement_deletion.sql`
2. `supabase/migrations/20261003180001_robot_instance_requirement_deletion_rpc.sql`

Apply them in timestamp order with explicit operator approval before deploying
this API and the matching market-fit confirmation and same-origin proxy. Missing
migration or incompatible schema fails closed. These migrations have been tested
locally, not applied to the remote project as part of this change.

Existing callers must adopt the explicit `delete_requirements: true` contract
and an authenticated owner/admin user session. Do not deploy the new UI alone
against the old endpoint: the old implementation cannot guarantee atomic cleanup.

## Offline tests

### Empty-scope timeout correction

The read-only preflight can hit SQLSTATE `57014` on a large `instance_logs` table:
the original lateral tag expansion scans unrelated logs even when the instance
owns no requirements. Small fixtures do not reveal that workload difference.

`20261005220000_bound_empty_instance_deletion_preflight.sql` changes only that
query to direct tag comparisons guarded by `cardinality(ids) > 0`. It preserves
all authorization and shared-history checks, including deployed changes elsewhere
in the function. An unexpected function definition blocks the migration rather
than silently replacing it. Apply only to the explicitly approved Makinari
target after review. The original code change did not apply it remotely; the
2026-10-19 read-only inspection subsequently confirmed it installed.

The isolated regression verifies the empty-set plan does not scan logs and that
20,000 unrelated logs survive deletion. All existing shared-tag denial cases
still run. This fixes the empty-scope scan; it is not a benchmark or a general
performance guarantee for large nonempty requirement graphs.

### Nonempty-scope timeout correction

The 2026-10-19 read-only production diagnosis found SQLSTATE `57014` in the
shared-history preflight even with the empty-scope correction installed. The
nonempty tag lookup planned a sequential scan over approximately 563,000 logs.
The existing user-action requirement index does not cover all log types or all
four JSON tag expressions.

The forward corrections are:

1. `20261019230000_index_deletion_log_details_requirement.sql`
2. `20261019230001_index_deletion_log_details_requirement_camel.sql`
3. `20261019230002_index_deletion_log_tool_requirement.sql`
4. `20261019230003_index_deletion_log_tool_requirement_camel.sql`
5. `20261019230004_indexed_instance_deletion_preflight.sql`

The first four add partial expression indexes for `lower(...)` on the two tag
spellings in `details` and `tool_args`. They cover every log type and tenant;
null tags consume no index entry. The last replaces only the reviewed tag lookup
with four indexed `UNION ALL` branches, retaining the empty-set guard and own
instance exclusion. Other authorization, execution, shared-history checks,
deployed status fixes, function ACLs and the atomic deletion RPC remain unchanged.
It rejects missing, invalid, wrong-expression, wrong-collation or incompatible
indexes and unexpected function definitions rather than installing a degraded
or less restrictive replacement. No global timeout or table permissions change.

#### Operator rollout

This is **not applied remotely**. Obtain explicit approval for Makinari before
application; never target Apps. Verify the existing empty-scope correction and
take a read-only copy of the current function definition/ACL for comparison.
Coordinate through the approved database-owner workflow: the inspection role
may lack function execution/DDL permissions and must not be escalated silently.

Run each of the four index files as its own standalone statement outside a
transaction, in order. Do not concatenate them into a transaction or a single
multi-statement request: PostgreSQL forbids concurrent builds in that context.
Monitor build progress/load and inspect `pg_index.indisvalid` and `indisready`
before proceeding. Concurrent builds allow writes but still consume I/O and wait
for existing transactions. Use an operator-controlled bounded execution budget,
not the browser's eight-second PostgREST budget.

An interrupted concurrent build may leave an invalid index. `IF NOT EXISTS`
does not repair it. After explicit review/approval, remove only the invalid new
index with `DROP INDEX CONCURRENTLY` outside a transaction and rerun its file.
Do not drop working existing indexes, bypass the final migration guard, or
change migration history merely to conceal an incomplete build.

Apply the complete fifth file as one transaction only after all four indexes are
valid. It runs `ANALYZE instance_logs` before installing the lookup: newly created
expression indexes otherwise lack selectivity statistics and may still lose to
a sequential scan. Analysis reads/samples the table without blocking normal
writes; allow its I/O cost and bounded lock wait in the rollout window.
Compare the function and ACL against the saved definition: only the tag
lookup should differ. Verify indexed custom/generic plans, empty-set behavior
and an authenticated read-only preflight on an approved instance. Do not delete
a real instance as an automatic verification step. Reconcile tracking through
the approved migration workflow; this project has some manually installed
objects not represented by its sparse migration ledger.

No web/API deployment is needed for these database corrections when the atomic
deletion route is already live. A web-only deployment cannot install them.
For rollback, prefer a reviewed forward query correction; keeping the indexes
is safe for correctness. Any index removal requires separate approval and
standalone concurrent statements. Never disable ownership or audit guards.

#### Regression coverage

The isolated SQL suite checks all four tag spellings, uppercase UUIDs containing
letters, multiple log types, same-tenant shared-instance and legacy cross-tenant
denial, untouched unrelated logs, index plans, rerun safety and definition/ACL
preservation. Legacy invalid rows are seeded only in the disposable fixture,
with its write guard restored before any deletion RPC is called.

The optional native PostgreSQL runner loads the checked-in prerequisite schema
in a fresh socket-only cluster, creates the indexes concurrently, and verifies
custom/generic indexed plans and the full read-only preflight with 563,000
synthetic tagged logs. It also checks invalid-build rejection. It requires local
PostgreSQL 17 binaries at `/opt/homebrew/opt/postgresql@17/bin`, never reads `.env`
or a database URL, and removes its own cluster on completion:

```sh
node src/app/api/robots/instance/delete/__tests__/deletion-native-postgres-runner.mjs
```

Synthetic local timings do not establish production latency or prove that other
large dependency graphs cannot time out. Revalidate on the approved target after
rollout without replaying an unconfirmed destructive request.

From the API repository:

```sh
npm run test:harness -- --runTestsByPath src/app/api/robots/instance/delete/__tests__/route.test.ts src/app/api/robots/instance/delete/__tests__/robot-instance-deletion-sql.test.ts
```

The endpoint tests use isolated transport doubles; the SQL tests use an isolated
PGlite PostgreSQL fixture, including the historical receipt migrations. They test
real constraints, triggers, rollback and authorization, but a single-connection
fixture does not prove multi-connection race behavior. No remote database or real
provider is mutated by these tests.