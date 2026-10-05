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
target after review; this change has not been applied remotely.

The isolated regression verifies the empty-set plan does not scan logs and that
20,000 unrelated logs survive deletion. All existing shared-tag denial cases
still run. This fixes the empty-scope scan; it is not a benchmark or a general
performance guarantee for large nonempty requirement graphs.

From the API repository:

```sh
npm run test:harness -- --runTestsByPath src/app/api/robots/instance/delete/__tests__/route.test.ts src/app/api/robots/instance/delete/__tests__/robot-instance-deletion-sql.test.ts
```

The endpoint tests use isolated transport doubles; the SQL tests use an isolated
PGlite PostgreSQL fixture, including the historical receipt migrations. They test
real constraints, triggers, rollback and authorization, but a single-connection
fixture does not prove multi-connection race behavior. No remote database or real
provider is mutated by these tests.