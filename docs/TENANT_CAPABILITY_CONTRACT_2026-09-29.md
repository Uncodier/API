# Tenant capability contract — 2026-09-29

## Objective

Generated apps consume verified tenant capabilities rather than inventing global
permissions, authentication infrastructure, buckets or backend RPCs. This is a
prompt contract backed by provisioning, protected helper ownership, validation,
the tenant migration linter and negative authorization tests, not prompt-only
security.

## Platform-provisioned identity

`20260929003000_apps_tenant_capabilities.sql` targets **Apps Supabase**. It is
independent of the operator-required `20260928235000` auth-grant migration and
requires no privileges on managed `auth` schemas. Existing app SQL and migration
receipts are not rewritten.

Three reserved helpers are installed in every registered active tenant schema:

- `_app_current_user_id()` — request UUID, NULL on missing/invalid identity.
- `_app_request_claims()` — request JWT claims, NULL on missing/malformed input.
- `_app_is_backend_request()` — exact signed role/subject/tenant/schema match
  against the tenant's registry binding, false otherwise.

All helpers are STABLE, SECURITY INVOKER, fixed `search_path=pg_catalog`, and owned
by `apps_migration_coordinator`. Execute is limited to the tenant owner, anon and
authenticated (and the owning coordinator). They do not set claims, create
memberships or grant data permissions. JWT signature verification remains the
responsibility of the platform's authenticated request boundary/PostgREST.

The service-role-only installer verifies the entire helper definition and ACL;
conflicting existing definitions fail closed instead of being overwritten. The
read-only getter never provisions. Repeated healthy installation makes no DDL or
ledger changes. New tenants get helpers in the platform provisioner before JWT
and app environment injection.

PostgreSQL schema owners can DROP contained objects even if another role owns
them. Coordinator ownership prevents replacement/ALTER, not destructive DROP.
The linter blocks helper mutation; missing/substituted helpers cause capability
discovery and subsequent execution preflight to fail closed. Do not claim that
the DB ownership pattern prevents all destructive schema-owner operations.

## Manifest and agent contract

`TenantCapabilities` is an allowlisted metadata receipt scoped to requirement,
tenant and schema. Extra fields from storage, envs or RPC responses are not copied
to prompts. It contains helper names, actual registry-bound Storage bucket
availability, and `backend: { role: 'authenticated', bypasses_rls: false,
operations: [] }`.

An empty operations list means **no app-specific operation has been registered
by the platform**, not that the helper authorizes all tables or that arbitrary
existing routines were audited. A present bucket means it exists, not that all
objects are public or every operation is allowed.

The coordinator, step executor and bounded migration-repair agent consume this
contract. Executors refresh capability metadata before each turn when provisioned.
`sandbox_db_capabilities` offers read-only discovery using the trusted bound
requirement, with no agent-selected tenant parameters. Missing capabilities return
`capability_gap`; the agent must not respond by widening grants or RLS.

Existing tenant reprovisioning also verifies the invoking subject/site against the
registry before minting the backend JWT; it cannot silently issue a token for a
different user while claiming the original backend capability.

Custom site secrets cannot override platform-owned Apps schema/JWT/config entries.
Values of tokens, signing keys, service keys and `.env` files are never part of the
manifest. The SDK clients still require runtime env values but discovery does not.

## Application rules

- Authentication is not tenant membership. Use row ownership or protected local
  membership according to the product's actual organization/role model.
- Do not replace organization collaboration with creator-only access to pass lint.
- User-editable metadata, submitted email, roles and organization IDs are not
  authority. Membership/role writes require an authorized backend operation.
- Public intake is a validated, rate-limited, transactional backend path, not an
  anonymous table policy or automatically verified Auth account.
- Consume reserved local helpers; do not create/alter/drop/shadow them. Persisted
  SQL routines must qualify tenant objects rather than rely on caller search_path.
- No schema enumeration, dynamic DDL, global grants, auth/storage table mutation,
  SECURITY DEFINER workarounds, claims mutation or editing applied migrations.
- Test anon, unrelated user/tenant, cross-org, authorized actor, escalation,
  persistence, rollback and idempotency. Lint alone cannot prove authorization.

## Rollout / validation

Apply the capabilities migration in Apps before deploying this API. Missing RPCs
fail closed. The migration backfills registered isolated tenants and leaves NEX's
legacy local helpers/application policies unchanged. Do not apply the separate
operator-required global auth ACL migration as a prerequisite.

Offline tests cover real PGlite provisioning/ACLs, read-only metadata, no-claims and
cross-tenant identities, malformed receipts, secret exclusion, prompts, helper
mutation rejection and local-helper tautology rejection. `npm run test:harness`
runs the suite from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`.

## Applied verification

Applied to Apps at `2026-09-29T00:21:52Z` (recorded version `20260929002152`).
All 178 active tenants have all three reserved helpers: 534 routines, all
coordinator-owned, SECURITY INVOKER, with fixed search paths. No auth schema
USAGE grants were added and NEX's two migration checksums are unchanged.

The read-only manifests for NEX and Visualgv return `storage.available=false`,
`bucket=null`, and no registered backend operations. This does not undo NEX's
app-specific registration RPC; it correctly avoids claiming it is a generic
platform operation. Missing buckets remain explicit provisioning gaps.

Local verification: **117 suites / 1,109 tests passed**. Repository-wide TypeScript
still reports unrelated pre-existing errors; none were reported in the changed
capability, provisioning or prompt files. Single-connection PGlite tests are not
a claim of multi-connection concurrency verification.

The existing Apps security-advisor warnings are unchanged; unrelated privileged
public RPCs and other legacy objects need a separate security review:
https://supabase.com/docs/guides/database/database-linter