---
name: makinari-obj-apps-supabase
description: Consume the verified Uncodie Apps Supabase tenant capabilities for DB, Auth, and Storage. Use when the requirement needs to persist data, authenticate end-users, or apply schema changes. Never bring your own Supabase project or invent platform capabilities.
types: ['develop', 'integration', 'task']
---

# SKILL: makinari-obj-apps-supabase

## Objective

Use the **Apps Supabase** (multi-tenant, schema-per-tenant) through the verified
capability contract. Write tenant application code and forward migrations, not
platform administration. RLS, product authorization, and tenant membership are
separate from successful authentication.

## First consume the verified capability manifest

Before writing database, auth, or storage code, consume the **verified manifest**
passed in the system context or returned by `sandbox_db_capabilities`. Only those
platform sources establish capabilities; an app file, user-supplied object, env
dump, or guessed convention does not. The version 1 contract has this shape
(this type is documentation, not a manifest to manufacture):

```ts
type DatabaseCapabilities<Schema extends string> = {
  version: 1;
  requirement_id: string;
  tenant_id: string;
  schema: Schema;
  identity: {
    user_id: `${Schema}._app_current_user_id`;
    claims: `${Schema}._app_request_claims`;
    backend: `${Schema}._app_is_backend_request`;
  };
  storage: { bucket: string | null; available: boolean };
  backend: { role: 'authenticated'; bypasses_rls: false; operations: [] };
};
```

- Use the exact `requirement_id`, `tenant_id`, `schema`, and qualified helper names
  from that manifest. Never invent IDs, infer a schema from an ID, guess helpers,
  buckets or RPCs, or reuse another requirement's manifest. Identity names have
  no parentheses in the manifest; SQL calls do.
- If the manifest is missing, inconsistent, or cannot be verified, stop the
  dependent work and report the specific provisioning gap. Do not manufacture a
  manifest, inspect env secrets, print `.env` / JWTs / keys, or decode a backend
  token to discover capabilities. Runtime code may consume injected configuration
  by name; inspecting secret values is not a discovery mechanism.
- The parent provisioner creates `_app_current_user_id()`,
  `_app_request_claims()`, and `_app_is_backend_request()` in **each tenant schema
  before the agent runs**. These helpers are platform-owned and immutable to the
  agent. Do not create, replace, alter, rename, drop, or shadow them, change their
  ownership/permissions, set request claims, or request auth/admin permissions.
  Report a missing helper as a platform provisioning failure instead.
- `_app_current_user_id()` supplies request identity, not tenant membership.
  `_app_request_claims()` supplies request claims, not a blanket authorization
  grant. Never authorize from `user_metadata` or other user-editable claims.
  Use protected tenant-local membership/roles for organization access.
- In ordinary migrations/policies, unqualified `_app_current_user_id()` is valid
  because the runner sets the tenant search path. In **persisted function
  definitions**, fully qualify every helper call and tenant table reference with
  the exact schema from the verified manifest. Do not persist a literal `schema`
  placeholder or rely on a caller's search path. Call local helpers instead of
  direct `auth.uid()` / `auth.jwt()` calls; do not repair access with auth grants.

## Envs the sandbox injects (do NOT redefine)

| Var | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_APPS_SUPABASE_URL` | bundle | Shared across all apps. Public by design. |
| `NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY` | bundle | Shared. RLS is the security boundary. |
| `NEXT_PUBLIC_APPS_TENANT_SCHEMA` | bundle | Must match the verified manifest's `schema`. No fallback. |
| `APPS_TENANT_JWT` | server-only | Platform backend token; not an end-user session or service-role key. Never inspect or expose it. |
| `APPS_AUTH_PROVIDER` | server-only | `supabase` (default) or `auth0`. |

Never read or write these envs from third-party `.env` templates — the
provisioner handles them per requirement. Do not default to `public`, generic
Supabase envs, a dummy URL/key, or a foreign project if configuration is missing.

## Application SDK clients (not platform SQL helpers)

Reuse the base app's clients when present. If missing, this browser example
consumes only public runtime configuration. The agent must first verify the
manifest/schema binding; an env name alone is not evidence of capabilities.

```ts
// src/lib/supabase.ts — browser client; server code uses the cookie client below
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_APPS_SUPABASE_URL?.trim();
const key = process.env.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY?.trim();
const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA?.trim();
if (!url || !key || !schema || schema === 'public') {
  throw new Error('Missing verified Apps Supabase tenant configuration');
}
export const db = createClient(url, key, { db: { schema } });
```

```ts
// src/utils/supabase/server.ts — Route handlers + Server Actions (RSC)
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_APPS_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY?.trim();
  if (!schema || schema === 'public' || !supabaseUrl || !supabaseKey) {
    throw new Error('Missing verified Apps Supabase tenant configuration');
  }

  const options: any = {
    db: { schema: schema as any },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: any) {
        try {
          cookiesToSet.forEach(({ name, value, options }: any) => {
            cookieStore.set(name, value, options)
          })
        } catch (error) {
          // The `set` method was called from a Server Component.
        }
      },
    },
  };

  return createServerClient<any>(supabaseUrl, supabaseKey, options)
}
```

The browser client uses the anon key + tenant schema — RLS filters by row
ownership (`_app_current_user_id() = user_id`) or protected tenant-local membership.
The cookie-based server client also acts with the user's session; it does not
automatically attach `APPS_TENANT_JWT` or bypass RLS. Backend jobs and public intake
need an explicitly authorized server-side operation, not merely a server client.
Never expose server credentials to the browser or put them in Next's `env` config.

## Migration contract (current linter; no exceptions)

`src/lib/services/apps-platform/migration-linter.ts` is the enforcement contract.
Fix rejected SQL; never weaken the linter or bypass the migration tools to make it apply.

- Write **static, tenant-only SQL**. Prefer unqualified names such as `reservations`:
  the migration runner already sets the tenant `search_path`. If qualification is
  necessary, use only the actual provisioned tenant schema, not a copied example
  or another tenant. Do not add `SET search_path`, `SET LOCAL search_path`, or
  `set_config()` to migrations.
- **`DO` blocks are forbidden**, including "idempotent" wrappers. Dynamic SQL
  (`EXECUTE`, including `EXECUTE format(...)`) and schema enumeration through
  `information_schema.schemata` or `pg_namespace` are forbidden. Never loop over
  `app_%` schemas. Use ordinary static DDL for this tenant only.
- **`GRANT` / `REVOKE` and schema, role, or extension administration are forbidden.**
  The platform manages privileges and schema exposure. Do not disable RLS, create
  `SECURITY DEFINER` routines, or try to widen access through a view; tenant views
  must use `WITH (security_invoker = true)`.
- Do not read/write other schemas (`public`, `auth`, `storage`, or another
  tenant), call privileged platform SQL RPCs, or touch the protected `_meta` /
  `_execute_tenant_migration` infrastructure. Call only the provisioned
  tenant-local identity helpers from the manifest; do not create/alter them or
  request access to `auth` tables/functions. No global SQL belongs in an app migration.
- Every new table needs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and an
  explicit policy **in the same migration file**, including tables created with
  `IF NOT EXISTS`. Policies must use row ownership, correlated membership, or an
  explicit deny predicate. Omitting predicates, unconditional access, and a
  standalone "user is logged in" check are not acceptable. `TO authenticated`
  alone is not tenant isolation: Supabase auth roles are shared across apps.

## How to add a table (CRUD ready in 4 steps)

1. Draft the migration as a single SQL file inside the app, e.g.
   `migrations/0001_reservations.sql`. This complete example is user-owned only
   when that matches the product contract; it is not a replacement for a shared
   organization model:

```sql
create table reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed',
  created_at timestamptz not null default now()
);
alter table reservations enable row level security;

create policy reservations_select on reservations
  for select to authenticated
  using (_app_current_user_id() = user_id);

create policy reservations_insert on reservations
  for insert to authenticated
  with check (_app_current_user_id() = user_id);

create policy reservations_update on reservations
  for update to authenticated
  using (_app_current_user_id() = user_id)
  with check (_app_current_user_id() = user_id);

create policy reservations_delete on reservations
  for delete to authenticated
  using (_app_current_user_id() = user_id);
```

2. Apply the migration using the `sandbox_db_migrate` tool. Do NOT use `sandbox_run_command` with custom scripts or `fetch` to apply migrations.

3. Verify the table exists using the `sandbox_db_inspect` tool. Do NOT write custom Node.js scripts to test the connection.

4. CRUD it from the SDK with the verified schema. **CRITICAL RULE**: ALWAYS
   explicitly use `.schema()` before calling `.from()` or tenant `.rpc()`. A
   schema-cache/configuration error is not a reason to fall back to `public`.

```ts
// DO THIS: Always specify the schema explicitly
const SCHEMA_NAME = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA?.trim();
if (!SCHEMA_NAME || SCHEMA_NAME === 'public') {
  throw new Error('Missing verified Apps Supabase tenant schema');
}

await db.schema(SCHEMA_NAME).from('reservations').insert({ user_id, starts_at, ends_at });
const { data } = await db.schema(SCHEMA_NAME).from('reservations').select('*').order('starts_at');
```

## RLS policy templates by table type (copy/adapt in migrations)

These are alternatives for **existing tenant tables**, not extra policies to layer
over permissive ones. Inspect existing policy names first. For replacements, use
`DROP POLICY IF EXISTS` before `CREATE POLICY` and remove obsolete permissive
policies explicitly in the same migration: permissive policies combine with OR,
so adding a restrictive-looking predicate does not repair another open policy.
Do not add a search-path preamble; the runner owns it.

Inspect the schema and product authorization contract first. The member examples
assume `studios` / `projects` have `organization_id`, and
`organization_memberships` has `organization_id`, `user_id`, and protected `role`.
Here members may read and only `editor` / `admin` members may manage projects;
use those role values only if the inspected model and product contract confirm
them. Do not invent a membership table, role names, or an existing RPC/helper.

Protect memberships with self-read RLS and no direct user writes to membership,
role, or permissions; only an explicitly authorized backend operation may change
them. Do not let users enroll into arbitrary organizations, even after OTP login.
Keep authorization non-recursive. Do not silently change a shared organization
model to creator-only ownership to make lint pass: preserve authorized team access
and role protections, or report the missing model/authorization prerequisite.

**Protected membership control table (self-read, no direct user writes)**
```sql
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_memberships_self_read ON organization_memberships;
CREATE POLICY organization_memberships_self_read ON organization_memberships
  FOR SELECT TO authenticated
  USING (user_id = _app_current_user_id());
```

This template requires removing any obsolete write/open policies discovered by
inspection in the same forward migration. Self-read does not grant membership
creation or role updates. Backend write access is not implied by this template.

**Reference/catalog table (member read; writes require an authorized operation)**
```sql
ALTER TABLE studios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studios_member_read ON studios;
CREATE POLICY studios_member_read ON studios
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = studios.organization_id
        AND m.user_id = _app_current_user_id()
    )
  );
```

**Private user-owned table (auth user owns row)**
```sql
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservations_select ON reservations;
CREATE POLICY reservations_select ON reservations
  FOR SELECT TO authenticated USING (_app_current_user_id() = user_id);

DROP POLICY IF EXISTS reservations_insert ON reservations;
CREATE POLICY reservations_insert ON reservations
  FOR INSERT TO authenticated WITH CHECK (_app_current_user_id() = user_id);

DROP POLICY IF EXISTS reservations_update ON reservations;
CREATE POLICY reservations_update ON reservations
  FOR UPDATE TO authenticated USING (_app_current_user_id() = user_id)
  WITH CHECK (_app_current_user_id() = user_id);

DROP POLICY IF EXISTS reservations_delete ON reservations;
CREATE POLICY reservations_delete ON reservations
  FOR DELETE TO authenticated USING (_app_current_user_id() = user_id);
```

**Team/org-scoped table (members read; authorized editors/admins manage org rows)**
```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_member_access ON projects;
DROP POLICY IF EXISTS projects_member_read ON projects;
CREATE POLICY projects_member_read ON projects
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = _app_current_user_id()
    )
  );

DROP POLICY IF EXISTS projects_editor_access ON projects;
CREATE POLICY projects_editor_access ON projects
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = _app_current_user_id()
        AND m.role IN ('editor', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = _app_current_user_id()
        AND m.role IN ('editor', 'admin')
    )
  );
```

**System/internal table (no direct anon/user access)**
```sql
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_events_no_direct_access ON webhook_events;
CREATE POLICY webhook_events_no_direct_access ON webhook_events
  FOR ALL
  USING (false)
  WITH CHECK (false);
```

**Control-table guardrails (`users`, `roles`, permissions)**
- Never query `users` from a policy on `users` itself; moving a recursive subquery
  into `WITH CHECK` does not solve recursion or privilege escalation.
- Use `id = _app_current_user_id()` for self-read of an inspected profile table.
  Self-registration requires explicit product authorization and a fixed safe
  non-privileged role enforced by RLS, not just a client-supplied default.
  A profile is not an organization membership; never grant org access on login.
- Ownership alone does not make arbitrary updates to `role`, permissions, or
  membership safe. Keep those writes on a trusted server-controlled path. Do not
  give self-update access to privilege-bearing fields.

## Backend identity is not an authorized data operation

`_app_is_backend_request()` checks the exact trusted top-level `sub`, `tenant_id`,
and `schema` claims against this tenant's provisioned registry binding. It does
not accept a merely present claim, a generic logged-in role, or `user_metadata`.
Do not reproduce, loosen, or forge this check in app migrations. The helper
identifies the platform backend request; it is **not** a service-role credential,
an RLS bypass, tenant/org membership, or a data operation.

The manifest's `backend.role` is `authenticated` and `backend.bypasses_rls` is
`false`. An `APPS_TENANT_JWT` request still obeys RLS; an end-user cookie client
is not that backend request. Keep backend credentials on the server, consumed
only at runtime by an authorized path; never inspect them to infer permissions.
`backend.operations: []` means **no app-specific backend operations are
registered**. It does not promise a contact-insert, onboarding, admin, or generic
CRUD RPC. Do not invent an existing RPC or use a guessed function name.

For a required backend flow:
1. Inspect the actual tenant tables, policies, constraints, and any existing
   routines with `sandbox_db_inspect`; obtain the explicit product authorization
   contract (actor, tenant, allowed operation, fields, and limits).
2. Only when that contract authorizes it, implement a **new app-specific
   transaction** against the inspected schema, with input validation, server-fixed
   tenant/destination, bounded effects, and operation-specific RLS using the
   provisioned backend helper. A helper check alone does not authorize every
   table, role change, or client-selected destination. Preserve the shared model.
3. If a tenant routine is needed, use a static `SECURITY INVOKER` definition with
   dollar-quoted SQL and fully qualified tenant tables/helper calls from the
   manifest. No dynamic SQL, grants, request-claim setters, global SQL, or
   `SECURITY DEFINER` workaround. Inspect for name collisions; creating a new
   routine does not mean it was a previously registered platform capability.
4. Probe both authorized and denied behavior, including ordinary authenticated
   users and other tenants. If the authorized contract or platform capability is
   missing, report that specific gap rather than request auth/admin access or
   weaken RLS. An empty operations list is not proof that an arbitrary RPC exists.

## Public intake is a server-controlled path, not an open table insert

An anonymous contact/signup form is **not** an exception to the linter or RLS.
Never use an unconditional insert policy (including `TO anon`) or weaken a table
to make a public form work. The same applies to anonymous catalog reads.
Use a narrow server-controlled endpoint with input validation, abuse controls,
and a fixed server-resolved tenant/destination; never trust client-supplied
schema, role, owner, or membership values. The endpoint must use an explicitly
authorized, platform-supported write path and return only safe response data.
Follow the backend operation contract above; a route handler alone does not make
an operation authorized. **Public intake must not create an auth account**,
membership, session, or privileged profile for an unverified visitor. Collect only
the product-authorized contact data. Account creation/onboarding may happen only
after identity verification through an explicitly supported, authorized flow;
if it is unavailable, report the gap rather than call auth admin APIs.
An ordinary cookie-based server client still obeys user RLS; moving an open
insert into a route handler is not authorization. If an authorized backend path
is unavailable, report that prerequisite rather than granting public table access.
For a genuinely public catalog, expose only reviewed non-sensitive fields through
a similarly controlled read endpoint or static data, not an open table policy.

The internal-table deny template assumes no other policy permits the request.
A trusted backend must have independently provisioned access; a server-side JWT
does not automatically override a deny predicate.

## Storage is only the reported capability

Use only the exact `storage.bucket` reported by the verified manifest, and only
when `storage.available` is `true` and the bucket is non-null. A reported bucket
is not permission to bypass its existing object policies or expose private data;
inspect the supported upload/read flow and apply the product's ownership rules.
Never derive a bucket from a tenant ID, guess a bucket name, create a substitute,
or use another app's bucket.

If the bucket is null/unavailable or the required upload/read operation is not
supported, report the **specific storage capacity gap** and affected feature.
Do not edit `storage.buckets`, `storage.objects`, storage policies, grants, or
other global SQL to supply missing capacity. Bucket provisioning and policy
administration belong to the platform, not app migrations.

The platform provisioner creates one private bucket per tenant via the Storage
API. The baseline platform policy supports two separate namespaces:

- `backend/<path>`: only the exact tenant-bound backend JWT, with object
  `owner_id` matching its subject. Never expose that token or this namespace
  through an unvalidated public upload/download endpoint.
- `users/<user-id>/<path>`: the authenticated user's own files, only with a
  protected platform `tenant_users` membership. Ordinary login does not create
  that membership. User metadata, chosen paths and organization IDs do not grant it.

This is private-file capacity, **not organization-shared assets**. Do not replace
product collaboration with personal ownership: shared/org storage requires a
separately reviewed platform authorization contract. Do not manufacture
memberships or use the backend token to bypass a missing user capability.
Use the exact manifest bucket, never a literal `assets` bucket; a nested `assets/`
folder may be used inside the authorized namespace. Files are limited to 10 MiB
and a platform MIME allowlist (JPEG, PNG, WebP, GIF, PDF, plain text, CSV, JSON,
octet-stream). Existing stricter limits are preserved. This per-file limit is
not an enforced aggregate tenant storage quota. Signed read URLs are bearer
capabilities; keep them short-lived and never treat a private bucket as public.

## Applied migration immutability vs pending edits

- **Applied migrations are immutable.** Preserve their original path and exact
  contents, including comments and whitespace. Never edit, rename, delete, or
  rewrite applied SQL to "fix" history. Checksum mismatches must not be bypassed.
  Restore the original applied file from version control if it was changed, then
  add a new forward migration for the repair.
- **Pending, never-applied migrations may be edited**, including a file rejected
  by the linter. Confirm application status from the migration tool's receipts /
  results first, especially when earlier files in a batch succeeded. A failure
  does not mean the whole migration directory is unapplied.
- The runner stops at the first failing file. Repair an invalid pending file
  before retrying; merely appending a later migration cannot unblock it. For an
  already-applied file, create a new uniquely named, ordered forward migration
  instead. Do not modify ledger rows or invoke privileged SQL RPCs yourself.
- Re-run `sandbox_db_migrate`, inspect with `sandbox_db_inspect`, and record the
  resulting receipt and validation evidence. Lint success is not proof of correct
  business authorization or runtime SQL behavior.

## Post-migration RLS validation (required)
1. Verify policy existence and schema-qualified table names with `sandbox_db_inspect`.
2. Probe role behavior: anon, authenticated non-member, member, editor/admin, and
   wrong-tenant requests as applicable. Use supported test sessions/tools, never
   set request claims or forge credentials to perform a probe.
3. Confirm system/internal tables deny user JWT calls and only the explicitly
   authorized backend operations succeed. Login alone must not confer membership.
4. Document table + policy names and probe outcomes in `requirement_status` or `step_output`.

## Auth recipes

- For the configured Supabase provider, use email OTP rather than passwords.
  Successful OTP verifies identity, **not tenant or organization membership**.
  The following recipe signs in an existing account without creating an account
  for unverified public intake. New-account onboarding requires a separately
  authorized verification flow; do not silently enable account creation to make
  a contact form work.
  
  **Step 1: Request OTP**
  Use `signInWithOtp` with account creation disabled. Use the existing supported
  email-verification UI; locale or other user-editable metadata is presentation
  data only, never an authorization or tenant-binding source.
  ```ts
  const { error } = await supabase.auth.signInWithOtp({ 
    email, 
    options: {
      shouldCreateUser: false,
    },
  });
  ```
  
  **Step 2: Verify OTP; do not grant membership on login**
  ```ts
  const { data, error } = await supabase.auth.verifyOtp({ 
    email, 
    token: code, 
    type: 'email' 
  });
  
  if (error || !data.user || !data.session) {
    throw new Error('Email verification failed');
  }
  // Continue through the inspected tenant membership/invitation flow.
  // Do not upsert roles, enroll into organizations, or overwrite existing profiles.
  ```
  Profile synchronization is allowed only after verification and when the product
  explicitly permits it, using the inspected profile table and non-privileged
  fields. Enforce ownership and safe fixed defaults in RLS; never overwrite roles
  or existing profiles, accept `user_metadata` privileges, or auto-enroll a user.
  Invitation-only apps must use the authorized invitation/membership flow.

  **Login UI**: Always use the existing `LoginOtp` component from the base repo (`src/components/auth/login-otp.tsx`) or adapt it as needed.

- If the configured provider is Auth0, use only the platform-supported, verified
  end-user exchange flow actually provided for this app. Do not invent an exchange
  endpoint or use `APPS_TENANT_JWT` as an end-user session. Missing exchange
  capability is a specific prerequisite to report, not a reason to mint tokens.

## Anti-patterns

- **Forgetting `.schema(SCHEMA_NAME)` before `.from()` or tenant `.rpc()`**.
  Always bind operations to the verified tenant; never default to `public`.
- **Overriding global fetch to force schema headers on every request**. Use the
  SDK's explicit schema selection for database operations, not global header
  changes that could leak into Auth or Storage requests.
- **Writing custom Node.js scripts (e.g. `test-api.js`) to test the database connection.** This often fails due to missing env vars or dependencies in the sandbox. INSTEAD, use the `sandbox_db_inspect` tool to verify if tables exist or to sample data.
- Adding `@supabase/supabase-js` with a foreign URL or service key.
- Writing migrations that touch `public.*`, `auth.*`, `storage.*`, or other
  tenants. Storage policies and bucket administration belong to the platform;
  call only the provisioned local helpers from tenant policies.
- **Disabling RLS or granting unconditional access.** Use ownership, correlated
  tenant-local membership, or explicit denial, never an open policy for a public form.
- **Recursive policies or self-service privilege escalation on control tables.**
  Follow the control-table guardrails above; a `WITH CHECK` clause is not a safe
  place to hide a recursive role lookup.
- Hard-coding or deriving the tenant schema. Use the verified manifest; runtime
  `process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA` must match it, with no fallback.
- Calling `apps_exec_sql` or privileged migration RPCs directly. Use
  `sandbox_db_migrate`, not raw HTTP, custom scripts, or platform credentials.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_db_capabilities` | Obtain the verified version 1 manifest when not already provided in system context. Report missing/inconsistent capabilities; never inspect env secrets to discover them. |
| `sandbox_db_migrate` | Apply pending SQL migrations to the tenant database schema. Use this after writing new migration files. |
| `sandbox_db_inspect` | Verify if a table exists or sample data from the tenant database schema. Use this INSTEAD of writing custom Node.js test scripts. |
| `sandbox_run_command` | `npm install @supabase/supabase-js` (already pinned at root for new bases). |
| `sandbox_write_file` | Create `src/lib/supabase.ts`, `src/lib/supabase-server.ts`, `migrations/*.sql`. |
| `requirement_status` | Mention `auth_provider` and the migration version after each schema change. |
| `requirement_backlog` | File `kind='crud'` items per entity; the Judge expects evidence of insert/select/update/delete against the tenant schema. |
