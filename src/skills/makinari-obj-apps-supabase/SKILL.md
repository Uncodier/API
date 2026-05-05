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
// src/lib/supabase-server.ts — Route handlers + Server Actions
import { createClient } from '@supabase/supabase-js';
export const dbServer = createClient(
  process.env.NEXT_PUBLIC_APPS_SUPABASE_URL!,
  process.env.APPS_TENANT_JWT!,
  { db: { schema: process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA! } }
);
```

The browser client uses the anon key + tenant schema — RLS filters by row ownership (`auth.uid() = user_id`) and local roles within the schema (`users` table). The server client carries the tenant JWT directly so backend routes can read/write without a user session (e.g. cron, webhooks).

## How to add a table (CRUD ready in 3 steps)

1. Draft the migration as a single SQL file inside the app, e.g.
   `migrations/0001_reservations.sql`. Always include the `enable row
   level security` + tenant policy in the same file:

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

-- Política de lectura: el usuario puede ver sus propias reservas o, si es admin, puede ver todas
create policy reservations_select on reservations
  for select
  using (
    auth.uid() = user_id OR 
    (SELECT role FROM users WHERE id = auth.uid() LIMIT 1) = 'admin'
  );

-- Política de inserción: el usuario solo puede insertar sus propias reservas
create policy reservations_insert on reservations
  for insert
  with check (auth.uid() = user_id);

-- Política de actualización: el usuario actualiza las suyas, el admin actualiza todas
create policy reservations_update on reservations
  for update
  using (
    auth.uid() = user_id OR 
    (SELECT role FROM users WHERE id = auth.uid() LIMIT 1) = 'admin'
  )
  with check (
    auth.uid() = user_id OR 
    (SELECT role FROM users WHERE id = auth.uid() LIMIT 1) = 'admin'
  );
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

## Auth recipes

- `APPS_AUTH_PROVIDER=supabase` (default). Wire `signInWithOtp` / `signInWithPassword` against the same Supabase client. **CRITICAL: Sincronización Inmediata en el Sign Up**: Después de usar `supabase.auth.signUp(...)` en un backend action o API route, debes hacer un insert inmediato a la tabla `users` del esquema actual (`NEXT_PUBLIC_APPS_TENANT_SCHEMA`).
  ```ts
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (data.user) {
    await supabase.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA!).from('users').insert({
      id: data.user.id,
      email: data.user.email,
      role: 'member' // Rol por defecto
    });
  }
  ```
  Asegúrate de que la política RLS en `users` permita este insert (ej. `with check (id = auth.uid())`). No confíes en custom claims en el JWT para aislar tenants, ya que la separación por esquema (`app_<id>`) provee el aislamiento necesario.

- `APPS_AUTH_PROVIDER=auth0`. Use the Auth0 React SDK and exchange the
  Auth0 token for a tenant JWT via `/api/platform/auth/exchange`. The
  Platform API verifies the Auth0 audience + tenant binding and returns
  `APPS_TENANT_JWT` for that user.

## Anti-patterns

- **Forgetting to call `.schema(SCHEMA_NAME)` before `.from()`**. The global client configuration `db: { schema }` is NOT reliable enough when using `@supabase/ssr` or `supabase-js`, and it will often lead to `public.table_name not found` errors. ALWAYS chain `.schema()` explicitly.
- **Overriding global fetch headers incorrectly**. Next.js discards headers passed as a plain object (`Record<string, string>`). If you override `global.fetch` in the Supabase client to inject `accept-profile` headers for schema isolation, you MUST initialize a native `Headers` object: `const newHeaders = new Headers(init?.headers); newHeaders.set('accept-profile', schema);` before passing it to `fetch`. DO NOT use `const newHeaders: Record<string, string> = {};`.
- **Writing custom Node.js scripts (e.g. `test-api.js`) to test the database connection.** This often fails due to missing env vars or dependencies in the sandbox. INSTEAD, use the `sandbox_db_inspect` tool to verify if tables exist or to sample data.
- Adding `@supabase/supabase-js` with a foreign URL or service key.
- Writing migrations that touch `public.*`, `auth.*` or `storage.*`
  outside the tenant bucket — the linter rejects them and your migration
  call returns 422.
- **Disabling RLS.** Always write policies based on row ownership (`auth.uid() = user_id`) and/or local roles within the schema.
- **Infinite Recursion on Control Tables (e.g., `users`).** NEVER query the `users` table within a `FOR SELECT` policy on the `users` table itself (this causes `infinite recursion detected`).
  - For reading `users`: Use `USING (true)` or `USING (id = auth.uid())`.
  - For inserting/updating `users`: Use `WITH CHECK (id = auth.uid())`.
  - If you absolutely must check admin roles inside the `users` table policies (e.g., for `FOR UPDATE` or `FOR DELETE`), restrict it via a subquery only in the `WITH CHECK` clause: `WITH CHECK ((SELECT role FROM users WHERE id = auth.uid() LIMIT 1) = 'admin')`. Do NOT put the subquery in a `FOR SELECT` policy on the same table.
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
