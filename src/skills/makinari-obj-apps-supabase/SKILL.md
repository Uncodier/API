---
name: makinari-obj-apps-supabase
description: How to consume the Uncodie Apps Supabase (DB + Auth) from inside a generated app. Use when the requirement needs to persist data, authenticate end-users, or apply schema changes. The sandbox already injects the tenant envs; never bring your own Supabase project.
types: ['develop', 'integration', 'task']
---

# SKILL: makinari-obj-apps-supabase

## Objective

Use the **Apps Supabase** (multi-tenant, schema-per-tenant) for data and
auth in generated apps. The sandbox already injects every env you need —
your job is to write code against the SDK helpers, not to manage projects,
keys or migrations directly.

## Envs the sandbox injects (do NOT redefine)

| Var | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_APPS_SUPABASE_URL` | bundle | Shared across all apps. Public by design. |
| `NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY` | bundle | Shared. RLS is the security boundary. |
| `NEXT_PUBLIC_APPS_TENANT_SCHEMA` | bundle | `app_<requirementId>`. Used in `db.schema`. |
| `APPS_TENANT_JWT` | server-only | Pre-signed JWT with `tenant_id` claim. |
| `APPS_AUTH_PROVIDER` | server-only | `supabase` (default) or `auth0`. |

Never read or write these envs from third-party `.env` templates — the
provisioner handles them per requirement.

## Required helpers (copy on first cycle if missing)

```ts
// src/lib/supabase.ts — browser + RSC
import { createClient } from '@supabase/supabase-js';
export const db = createClient(
  process.env.NEXT_PUBLIC_APPS_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY!,
  { db: { schema: process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA! } }
);
```

```ts
// src/utils/supabase/server.ts — Route handlers + Server Actions (RSC)
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';

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

  if (schema && schema !== 'public') {
    options.global = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const newHeaders = new Headers(init?.headers);
        newHeaders.set('accept-profile', schema);
        newHeaders.set('content-profile', schema);
        return fetch(input, { ...init, headers: newHeaders });
      }
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_APPS_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy.supabase.co';
  const supabaseKey = process.env.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key_to_prevent_client_crash';

  return createServerClient<any>(
    supabaseUrl.trim() === '' ? 'https://dummy.supabase.co' : supabaseUrl,
    supabaseKey.trim() === '' ? 'dummy_key_to_prevent_client_crash' : supabaseKey,
    options
  )
}
```

The browser client uses the anon key + tenant schema — RLS filters by row ownership (`auth.uid() = user_id`) or tenant-local membership. The cookie-based server helper above also acts with the user's session; it does not automatically attach `APPS_TENANT_JWT` or bypass RLS. Backend jobs and public intake need an explicitly authorized server-side write path. Never expose server credentials to the browser.

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
  `_execute_tenant_migration` infrastructure. The allowed auth helpers
  `auth.uid()`, `auth.jwt()`, `auth.email()`, and `auth.role()` are not permission
  to access `auth` tables.
- Every new table needs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and an
  explicit policy **in the same migration file**, including tables created with
  `IF NOT EXISTS`. Policies must use row ownership, correlated membership, or an
  explicit deny predicate. Omitting predicates, unconditional access, and a
  standalone "user is logged in" check are not acceptable. `TO authenticated`
  alone is not tenant isolation: Supabase auth roles are shared across apps.

## How to add a table (CRUD ready in 4 steps)

1. Draft the migration as a single SQL file inside the app, e.g.
   `migrations/0001_reservations.sql`. This complete example is user-owned:

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
  using (auth.uid() = user_id);

create policy reservations_insert on reservations
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy reservations_update on reservations
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy reservations_delete on reservations
  for delete to authenticated
  using (auth.uid() = user_id);
```

2. Apply the migration using the `sandbox_db_migrate` tool. Do NOT use `sandbox_run_command` with custom scripts or `fetch` to apply migrations.

3. Verify the table exists using the `sandbox_db_inspect` tool. Do NOT write custom Node.js scripts to test the connection.

4. CRUD it from the SDK. RLS does the rest. **CRITICAL RULE**: ALWAYS explicitly use `.schema()` before calling `.from()`. Due to a bug in `@supabase/ssr`, relying on the global client options often defaults back to the `public` schema and throws `Could not find the table 'public.<table_name>' in the schema cache` (PGRST205 or PGRST106).

```ts
// DO THIS: Always specify the schema explicitly
const SCHEMA_NAME = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';

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

The member examples assume `studios` / `projects` have `organization_id`, and
`organization_memberships` has `organization_id` and `user_id`. Protect the
membership table with RLS allowing users to read only their own memberships;
only a trusted backend may create/change memberships or roles. Do not let users
enroll themselves into arbitrary organizations. Use an inspected, non-recursive
authorization model, not an assumed `get_user_role()` helper.

**Reference/catalog table (member read, trusted backend manages)**
```sql
ALTER TABLE studios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studios_member_read ON studios;
CREATE POLICY studios_member_read ON studios
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = studios.organization_id
        AND m.user_id = auth.uid()
    )
  );
```

**Private user-owned table (auth user owns row)**
```sql
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservations_select ON reservations;
CREATE POLICY reservations_select ON reservations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS reservations_insert ON reservations;
CREATE POLICY reservations_insert ON reservations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS reservations_update ON reservations;
CREATE POLICY reservations_update ON reservations
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS reservations_delete ON reservations;
CREATE POLICY reservations_delete ON reservations
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
```

**Team/org-scoped table (members may read and manage their organization's rows)**
```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_member_access ON projects;
CREATE POLICY projects_member_access ON projects
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = auth.uid()
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
- Use `id = auth.uid()` for self-read. Self-registration also needs a fixed safe
  role, e.g. `WITH CHECK (id = auth.uid() AND role = 'member')`.
- Ownership alone does not make arbitrary updates to `role`, permissions, or
  membership safe. Keep those writes on a trusted server-controlled path. Do not
  give self-update access to privilege-bearing fields.

## Public intake is a server-controlled path, not an open table insert

An anonymous contact/signup form is **not** an exception to the linter or RLS.
Never use an unconditional insert policy (including `TO anon`) or weaken a table
to make a public form work. The same applies to anonymous catalog reads.
Use a narrow server-controlled endpoint with input validation, abuse controls,
and a fixed server-resolved tenant/destination; never trust client-supplied
schema, role, owner, or membership values. The endpoint must use an explicitly
authorized, platform-supported write path and return only safe response data.
An ordinary cookie-based server client still obeys user RLS; moving an open
insert into a route handler is not authorization. If an authorized backend path
is unavailable, report that prerequisite rather than granting public table access.
For a genuinely public catalog, expose only reviewed non-sensitive fields through
a similarly controlled read endpoint or static data, not an open table policy.

The internal-table deny template assumes no other policy permits the request.
A trusted backend must have independently provisioned access; a server-side JWT
does not automatically override a deny predicate.

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
2. Probe role behavior: anon/member/admin (as applicable to table intent).
3. Confirm system/internal tables deny user JWT calls while backend flows keep working.
4. Document table + policy names and probe outcomes in `requirement_status` or `step_output`.

## Auth recipes

- `APPS_AUTH_PROVIDER=supabase` (default). **CRITICAL PRACTICE**: All generated apps MUST use OTP (One-Time Password) via email for login/signup instead of traditional passwords. This validates the email and ties the user to the tenant correctly. Wire `signInWithOtp` and `verifyOtp` against the Supabase client.
  
  **Step 1: Request OTP**
  Pass `options.data.locale` (and `site_id` when known) so Auth emails use the correct language. Auth emails include both a magic link and a visible OTP code — support verifying via link or `verifyOtp`.
  ```ts
  const { error } = await supabase.auth.signInWithOtp({ 
    email, 
    options: {
      shouldCreateUser: true,
      data: {
        locale: 'es', // or site default_locale / user preference
        site_id: process.env.NEXT_PUBLIC_SITE_ID,
      },
    },
  });
  ```
  
  **Step 2: Verify OTP and Sync User (Sincronización Inmediata)**
  Después de verificar el código OTP exitosamente, registra al usuario nuevo en
  `users` del tenant actual (`NEXT_PUBLIC_APPS_TENANT_SCHEMA`) sin sobrescribir
  perfiles ni roles existentes. Este ejemplo presupone auto-registro permitido
  por el producto; en apps por invitación, usa el flujo autorizado del servidor.
  ```ts
  const { data, error } = await supabase.auth.verifyOtp({ 
    email, 
    token: code, 
    type: 'email' 
  });
  
  if (data.user) {
    // Asegurar que el usuario existe en el tenant actual
    const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';
    await supabase.schema(schema as any).from('users').upsert({
      id: data.user.id,
      email: data.user.email,
      role: 'member' // Rol por defecto
    }, { onConflict: 'id', ignoreDuplicates: true });
  }
  ```
  La política de insert debe exigir `WITH CHECK (id = auth.uid() AND role = 'member')`;
  enviar `role: 'member'` desde el cliente no es una protección. No habilites
  actualizaciones arbitrarias de roles para permitir el login. El esquema por
  tenant no sustituye a RLS: usa ownership o membresía local y nunca confíes en
  claims editables por el usuario para conceder acceso o privilegios.

  **Login UI**: Always use the existing `LoginOtp` component from the base repo (`src/components/auth/login-otp.tsx`) or adapt it as needed.

- `APPS_AUTH_PROVIDER=auth0`. Use the Auth0 React SDK and exchange the
  Auth0 token for a tenant JWT via `/api/platform/auth/exchange`. The
  Platform API verifies the Auth0 audience + tenant binding and returns
  `APPS_TENANT_JWT` for that user.

## Anti-patterns

- **Forgetting to call `.schema(SCHEMA_NAME)` before `.from()`**. The global client configuration `db: { schema }` is NOT reliable enough when using `@supabase/ssr` or `supabase-js`, and it will often lead to `public.table_name not found` errors. ALWAYS chain `.schema()` explicitly.
- **Overriding global fetch headers incorrectly**. Next.js discards headers passed as a plain object (`Record<string, string>`). If you override `global.fetch` in the Supabase client to inject `accept-profile` headers for schema isolation, you MUST initialize a native `Headers` object: `const newHeaders = new Headers(init?.headers); newHeaders.set('accept-profile', schema);` before passing it to `fetch`. DO NOT use `const newHeaders: Record<string, string> = {};`.
- **Writing custom Node.js scripts (e.g. `test-api.js`) to test the database connection.** This often fails due to missing env vars or dependencies in the sandbox. INSTEAD, use the `sandbox_db_inspect` tool to verify if tables exist or to sample data.
- Adding `@supabase/supabase-js` with a foreign URL or service key.
- Writing migrations that touch `public.*`, `auth.*`, `storage.*`, or other
  tenants. Storage policies and bucket administration belong to the platform;
  call only the allowed auth helpers from tenant policies.
- **Disabling RLS or granting unconditional access.** Use ownership, correlated
  tenant-local membership, or explicit denial, never an open policy for a public form.
- **Recursive policies or self-service privilege escalation on control tables.**
  Follow the control-table guardrails above; a `WITH CHECK` clause is not a safe
  place to hide a recursive role lookup.
- Hard-coding the tenant schema. Always read
  `process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA`.
- Calling `apps_exec_sql` directly. The RPC is service-role only — go
  through `/api/platform/db/migrations`.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_db_migrate` | Apply pending SQL migrations to the tenant database schema. Use this after writing new migration files. |
| `sandbox_db_inspect` | Verify if a table exists or sample data from the tenant database schema. Use this INSTEAD of writing custom Node.js test scripts. |
| `sandbox_run_command` | `npm install @supabase/supabase-js` (already pinned at root for new bases). |
| `sandbox_write_file` | Create `src/lib/supabase.ts`, `src/lib/supabase-server.ts`, `migrations/*.sql`. |
| `requirement_status` | Mention `auth_provider` and the migration version after each schema change. |
| `requirement_backlog` | File `kind='crud'` items per entity; the Judge expects evidence of insert/select/update/delete against the tenant schema. |
