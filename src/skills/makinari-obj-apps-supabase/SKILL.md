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

The browser client uses the anon key + tenant schema — RLS filters by the
`tenant_id` claim of the user’s session JWT (Supabase Auth issues it via
`custom_access_token_hook`). The server client carries the tenant JWT
directly so backend routes can read/write without a user session (e.g.
cron, webhooks).

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
create policy reservations_tenant on reservations
  using (auth.jwt()->>'tenant_id' = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id')
  with check (auth.jwt()->>'tenant_id' = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id');
```

2. Apply the migration using the `sandbox_db_migrate` tool. Do NOT use `sandbox_run_command` with custom scripts or `fetch` to apply migrations.

3. Verify the table exists using the `sandbox_db_inspect` tool. Do NOT write custom Node.js scripts to test the connection.

4. CRUD it from the SDK. RLS does the rest. **CRITICAL RULE**: ALWAYS explicitly use `.schema()` before calling `.from()`. If you rely on the global client options, Supabase often defaults back to the `public` schema and throws `Could not find the table 'public.<table_name>' in the schema cache` (PGRST205 or PGRST106).

```ts
// DO THIS: Always specify the schema explicitly
const SCHEMA_NAME = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA;

await db.schema(SCHEMA_NAME).from('reservations').insert({ user_id, starts_at, ends_at });
const { data } = await db.schema(SCHEMA_NAME).from('reservations').select('*').order('starts_at');
```

## Auth recipes

- `APPS_AUTH_PROVIDER=supabase` (default). Wire `signInWithOtp` /
  `signInWithPassword` against the same Supabase client; the
  `custom_access_token_hook` injects `tenant_id` automatically. Do NOT
  call `signUp` without a server-side `tenant_users` insert — the
  provisioner already added the bridge during ensureTenant.
- `APPS_AUTH_PROVIDER=auth0`. Use the Auth0 React SDK and exchange the
  Auth0 token for a tenant JWT via `/api/platform/auth/exchange`. The
  Platform API verifies the Auth0 audience + tenant binding and returns
  `APPS_TENANT_JWT` for that user.

## Anti-patterns

- **Forgetting to call `.schema(SCHEMA_NAME)` before `.from()`**. The global client configuration `db: { schema }` is NOT reliable enough when using `@supabase/ssr` or `supabase-js`, and it will often lead to `public.table_name not found` errors. ALWAYS chain `.schema()` explicitly.
- **Writing custom Node.js scripts (e.g. `test-api.js`) to test the database connection.** This often fails due to missing env vars or dependencies in the sandbox. INSTEAD, use the `sandbox_db_inspect` tool to verify if tables exist or to sample data.
- Adding `@supabase/supabase-js` with a foreign URL or service key.
- Writing migrations that touch `public.*`, `auth.*` or `storage.*`
  outside the tenant bucket — the linter rejects them and your migration
  call returns 422.
- Disabling RLS or writing policies without the `tenant_id` claim. Rejected.
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
