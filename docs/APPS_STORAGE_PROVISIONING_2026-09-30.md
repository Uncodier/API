# Apps Storage provisioning

## Boundary and access contract

One private bucket per tenant, named by the trusted `apps_tenants` registry.
App migrations still cannot touch `storage.*`; no new agent tool or administrative
credentials are exposed. `ensureTenant` verifies the caller's registry binding,
calls the platform-only Storage operation and refreshes capabilities on success
before issuing the backend JWT. Optional Storage failures retain DB/Auth capacity
but report `storage.available=false` and log a sanitized reason; they do not
block every existing app during rollout. Database creation and Storage API calls are a retryable
saga, **not one atomic transaction**.

The forward platform migration installs four policies and a protected verifier.
It does not create buckets through SQL, insert memberships, modify applied tenant
migrations, or change the `workspaces` bucket. Bucket creation uses the official
Storage API. Unexpected bucket configuration fails closed and is not overwritten.
Concurrent creates tolerate only recognized already-exists errors and verify the
winning bucket. Only an explicit bucket-not-found response permits creation.

Baseline access is deliberately narrow:

| Namespace | Required authorization |
| --- | --- |
| `backend/<path>` | Exact authenticated backend subject, tenant and schema from the active registry; object owner equals subject |
| `users/<user-id>/<path>` | Authenticated subject owns the path and object, protected platform membership exists; supplied tenant/schema claims must match |

Anonymous access, unrelated users/tenants, path traversal, ownership changes and
cross-bucket moves without authorization are denied. Suspension or membership
removal revokes subsequent RLS access. Signed URLs already issued remain bearer
capabilities until expiry. Service-role callers bypass RLS and are not a valid
positive RLS test. Backend tokens must remain server-only; a public endpoint still
needs product-specific authorization, validation and abuse controls.

This baseline is **not an organization-shared storage implementation**. Existing
app-local organization memberships are not automatically platform memberships;
do not replace collaborative product authorization with creator-only access or
automatically grant memberships. A user session alone is not authorization.
Provisioning buckets does not claim that every app's upload UI is integrated.

The preflight also rejects known publicly executable unscoped mutation RPCs and
unreviewed additional permissive Storage policies. Protected memberships are not
trustworthy if another RPC lets anonymous callers write them as an administrator.
Legacy global RPC remediation is a separate operator task, not something this
provisioner silently revokes. The existing `workspaces service only` policy is
the sole reviewed unrelated permissive policy.

New buckets have a 10 MiB per-file ceiling and allow JPEG, PNG, WebP, GIF, PDF,
plain text, CSV, JSON and octet-stream. MIME restrictions are not content scanning.
Existing stricter size/MIME limits are preserved. `max_storage_mb` is a separate
aggregate quota declaration; this change does not claim to enforce aggregate
usage. No file is public by default and `assets` is not a global bucket name.

## Deployment order

1. Apply the forward migration
   `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20260930020000_apps_tenant_storage.sql`
   to **Apps** (`faxxouxekfwxvexoitxv`), not the main Makinari database, through the
   platform migration channel. Managed Storage DDL needs the operator's existing
   authority; if denied, stop and escalate rather than granting roles to tenants.
2. Pilot the backfill for one existing requirement; run the HTTP authorization
   probes, then expand to the remaining active tenants.
3. Deploy the API changes so subsequent `ensureTenant` calls provision Storage.
4. Refresh capabilities in existing app runs. Clear only a matching storage
   blocker after actual app validation; this code does not rewrite backlog state.

The v1 database capability RPC remains a metadata-only bucket existence check.
The API's read-only capability service additionally verifies platform policies
and live bucket configuration before reporting Storage usable; failures report
Storage unavailable while retaining valid DB capabilities. Discovery never repairs.

## Operator backfill

Use the installed `tsx`, with `APPS_SUPABASE_URL` and
`APPS_SUPABASE_SERVICE_KEY` provided in the operator environment. Existing
`REPOSITORY_SUPABASE_*` aliases are supported. No credentials are passed in CLI
arguments, printed or persisted by the script. An explicit project ref must match
the configured URL. The default mode is read-only; `--apply` enables creation.

From `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```sh
./node_modules/.bin/tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/backfill-apps-storage.ts --project-ref=faxxouxekfwxvexoitxv
./node_modules/.bin/tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/backfill-apps-storage.ts --project-ref=faxxouxekfwxvexoitxv --apply
```

`--requirement=UUID` scopes a pilot. `--limit=N` bounds a run. Keyset pagination
reads 20 tenants per page, performs operations sequentially, records safe per-row
results, and returns a nonzero exit code for failures or a missing requested
requirement. Reruns verify existing buckets without changing them. No bucket or
file cleanup is automatic: retention needs a separate explicit operation. A
destroyed/removed registry binding denies runtime access to orphaned buckets.

## Validation

`npm run test:harness` includes the Storage service tests and actual PostgreSQL
RLS tests via PGlite. PGlite tests do not prove JWT verification or Storage HTTP
behavior. Live probes must check an unauthenticated upload rejection, an exact
backend authenticated upload success, persisted bytes, user/tenant isolation,
private reads, update/delete behavior and cleanup through the Storage API.

Never use a service-role upload as evidence that user RLS works. Ordinary user
uploads require authorized membership provisioning; do not create memberships in
production merely to pass a probe.

## Verified rollout status — 2026-09-30

Implementation is present in this working tree, **not activated in production**.
The official Management migrations endpoint rejected `apps_tenant_storage` with
HTTP 400 / PostgreSQL P0001:

> Apps Storage requires operator repair of unsafe public mutation RPC privileges

The attempted migration SHA-256 was
`217e424ca01308b04e9a9ec427b408cc28a3dc2a17a15027b898534b5cd9e9ef`.
Read-only verification at `2026-09-30T21:15:30Z` confirmed zero new functions,
zero new policies, zero migration history entries, 179 active tenants still
missing buckets, and only the unchanged private `workspaces` bucket. An operator
backfill dry run with `--limit=1` returned `policy_preflight_failed`, created zero
buckets and exited nonzero. Storage API `getBucket('workspaces')` succeeded;
Storage is not globally unavailable.

Blocking legacy functions confirmed in Apps:

- `public.exec_sql(q text)` executes arbitrary SQL as postgres.
- `public.insert_schema_table_row(...)` writes arbitrary selected tables as postgres.
- `public.update_schema_table_row(...)` updates arbitrary selected tables as postgres.

All three were SECURITY DEFINER and callable by PUBLIC/anon/authenticated. Before
rollout, audit their callers and replace or restrict these administrative entry
points through a separate platform migration, including PUBLIC grants and any
other equivalent entry points. Do not grant end users arbitrary SQL. The Storage
preflight denylist identifies known dangerous entry points; it is not a complete
security audit of every function in the project. See the Supabase
[database security advisor](https://supabase.com/docs/guides/database/database-linter).

After that remediation, reapply the Storage migration via the operator channel.
Managed Storage policy ownership may be a further prerequisite: the current
postgres role is not a member of `supabase_storage_admin`; do not bypass a policy
ownership error or grant privileges to tenant migration roles. The rejected
attempt stopped before reaching policy DDL, so that channel's policy DDL authority
has not been proven in this rollout.

Local verification: **132 harness suites / 1,745 tests passed**, including eight
actual PostgreSQL authorization test cases with additional attack matrices.
Repository-wide TypeScript still fails on pre-existing unrelated files; no
diagnostics refer to the new Storage files or changed provisioning files. No
production upload 2xx/4x checks were run: there is no safely provisioned pilot
bucket yet. No backlog blockers, memberships or application code were changed,
and this session did not deploy the API.

## Administrative RPC repair prepared — 2026-09-30

A follow-up caller audit also identified the exposed
`public.delete_schema_table_rows(text,text,text,jsonb)` (plural), absent from the
initial denylist. Both Storage preflight checks now include that name, with a
regression case; the Storage migration was still unapplied when edited. The
checksum above records the earlier rejected attempt, not the updated file.

Apply the new prerequisite migration in **Apps**, before the Storage migration:

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20260930015000_apps_admin_mutation_rpc_acl.sql`

It revokes EXECUTE from PUBLIC, anon and authenticated on the four audited
administrative mutation functions and preserves service_role execution. It does
not delete functions, change bodies/owners or alter tables, memberships or
Storage policies. Effective grants are checked afterwards: unreviewed overloads
or inherited grants cause rollback rather than a partial repair. This file is
prepared for operator execution; it has not been applied by this follow-up.

Caller audit: this API uses the separate, already service-only `apps_exec_sql`.
The dashboard's server actions in
`/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/applications/actions.ts`
use insert/update/delete RPCs after user/site-manager authorization with a
server-side repositories client. Its local repositories URL points to Apps and
the local key is service_role. Deployed configuration and unknown external
clients are not verified; direct browser/anon/authenticated calls will be denied
intentionally and must not be restored to fix an integration.

This is a targeted administrative mutation repair, not a complete audit of
other legacy SECURITY DEFINER read/introspection RPCs. Do not disable Storage's
preflight or expose administrative credentials to an app to bypass it.