/**
 * Tenant provisioner for the Apps Supabase project (schema-per-tenant model).
 *
 * Responsibilities:
 *   - `ensureTenant(requirement)`  → idempotent: row in `public.apps_tenants`,
 *     create schema `app_<requirementId>`, apply baseline migration, mint
 *     tenant JWT for the sandbox.
 *   - `destroyTenant(requirement)` → drops the schema, deletes the row,
 *     revokes JWTs (cascade).
 *   - `bootstrapAuthForTenant(requirement, provider)` → ensures the auth
 *     adapter (Supabase Auth or Auth0) is configured.
 *
 * Notes:
 *   - SQL DDL is dispatched via the service-role client. Supabase JS does not
 *     expose `query()`; we rely on RPC `exec_sql` (created by
 *     `create_apps_platform_tables.sql`). If RPC is unavailable in the target
 *     project, the function logs a warning and exits early — the SQL bundle
 *     can be applied manually from the dashboard.
 *   - All side effects are guarded by try/catch and idempotent checks (the
 *     existence query in `apps_tenants` plus `if not exists` in the DDL).
 */
import { getAppsAdminClient, issueTenantJWT } from '@/lib/database/apps-supabase';

export type AppsAuthProvider = 'supabase' | 'auth0';

export interface EnsureTenantInput {
  requirement_id: string;
  user_id: string;
  site_id: string;
  /** Defaults to 'supabase'. */
  auth_provider?: AppsAuthProvider;
}

export interface EnsureTenantResult {
  tenant_id: string;
  schema: string;
  bucket: string;
  jwt: string;
  jwt_expires_at: string;
  auth_provider: AppsAuthProvider;
  created: boolean;
}

function schemaForRequirement(requirementId: string): string {
  return `app_${requirementId.replace(/-/g, '').slice(0, 24)}`;
}
function bucketForRequirement(requirementId: string): string {
  return `tenant-${requirementId.replace(/-/g, '').slice(0, 24)}`;
}

async function execSql(sql: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getAppsAdminClient();
    const { error } = await client.rpc('apps_exec_sql', { sql });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const BASELINE_MIGRATION = (schema: string, tenantId: string) => `
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = '${schema}') then
    execute 'create schema "${schema}"';
  end if;
end $$;

-- Grant usage to API roles so PostgREST can access the schema
grant usage on schema "${schema}" to anon, authenticated;
grant all privileges on all tables in schema "${schema}" to anon, authenticated;
grant all privileges on all routines in schema "${schema}" to anon, authenticated;
grant all privileges on all sequences in schema "${schema}" to anon, authenticated;

alter default privileges in schema "${schema}" grant all privileges on tables to anon, authenticated;
alter default privileges in schema "${schema}" grant all privileges on routines to anon, authenticated;
alter default privileges in schema "${schema}" grant all privileges on sequences to anon, authenticated;

create table if not exists "${schema}"."_meta" (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table "${schema}"."_meta" enable row level security;

drop policy if exists tenant_isolation on "${schema}"."_meta";
create policy tenant_isolation on "${schema}"."_meta"
  using (false);


insert into "${schema}"."_meta" (key, value)
values ('provisioned', jsonb_build_object('at', now()::text, 'tenant_id', '${tenantId}'))
on conflict (key) do update set value = excluded.value, updated_at = now();
`;

const APP_TENANT_TABLE_BOOTSTRAP = `
create table if not exists public.apps_tenants (
  tenant_id uuid primary key,
  requirement_id uuid not null,
  user_id uuid not null,
  site_id uuid not null,
  schema text not null,
  bucket text not null,
  auth_provider text not null default 'supabase',
  status text not null default 'active',
  requires_isolation boolean not null default false,
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists apps_tenants_requirement_unique
  on public.apps_tenants (requirement_id);
`;

export async function ensureTenant(input: EnsureTenantInput): Promise<EnsureTenantResult> {
  const { requirement_id, user_id, site_id, auth_provider = 'supabase' } = input;
  const client = getAppsAdminClient();
  const schema = schemaForRequirement(requirement_id);
  const bucket = bucketForRequirement(requirement_id);

  await execSql(APP_TENANT_TABLE_BOOTSTRAP).catch(() => undefined);

  const { data: existing } = await client
    .from('apps_tenants')
    .select('tenant_id, schema, bucket, auth_provider')
    .eq('requirement_id', requirement_id)
    .maybeSingle();

  let tenantId: string;
  let created = false;
  if (existing?.tenant_id) {
    tenantId = existing.tenant_id as string;
  } else {
    tenantId = (globalThis.crypto?.randomUUID?.() ?? requirement_id) as string;
    const { error } = await client.from('apps_tenants').insert({
      tenant_id: tenantId,
      requirement_id,
      user_id,
      site_id,
      schema,
      bucket,
      auth_provider,
      status: 'active',
    });
    if (error) {
      throw new Error(`tenant-provisioner: insert apps_tenants failed: ${error.message}`);
    }
    created = true;
  }

  const baseline = await execSql(BASELINE_MIGRATION(schema, tenantId));
  if (!baseline.ok) {
    console.warn(
      `[tenant-provisioner] baseline migration skipped (${baseline.error}). Apply manually with create_apps_platform_tables.sql.`,
    );
  } else {
    // Automatically expose the new schema to PostgREST
    const exposeSql = `
      do $$
      declare
        current_schemas text;
      begin
        select string_agg(nspname, ',') into current_schemas
        from pg_namespace
        where nspname like 'app_%' or nspname in ('public', 'graphql_public', 'storage');
        
        execute format('alter role authenticator set pgrst.db_schemas = %L', current_schemas);
      end $$;
      notify pgrst, 'reload config';
    `;
    const exposeResult = await execSql(exposeSql);
    if (!exposeResult.ok) {
      console.warn(`[tenant-provisioner] failed to auto-expose schema to PostgREST: ${exposeResult.error}`);
    } else {
      console.log(`[tenant-provisioner] auto-exposed schemas to PostgREST.`);
    }
  }

  const { token, expires_at } = await issueTenantJWT({
    tenant_id: tenantId,
    schema,
    user_id,
  });

  return {
    tenant_id: tenantId,
    schema,
    bucket,
    jwt: token,
    jwt_expires_at: expires_at,
    auth_provider,
    created,
  };
}

export async function destroyTenant(requirement_id: string): Promise<{ ok: boolean; error?: string }> {
  const client = getAppsAdminClient();
  const { data: row } = await client
    .from('apps_tenants')
    .select('tenant_id, schema')
    .eq('requirement_id', requirement_id)
    .maybeSingle();
  if (!row) return { ok: true };

  const drop = await execSql(`drop schema if exists "${row.schema}" cascade;`);
  if (!drop.ok) return { ok: false, error: drop.error };

  // Update exposed schemas after dropping
  await execSql(`
    do $$
    declare
      current_schemas text;
    begin
      select string_agg(nspname, ',') into current_schemas
      from pg_namespace
      where nspname like 'app_%' or nspname in ('public', 'graphql_public', 'storage');
      
      execute format('alter role authenticator set pgrst.db_schemas = %L', current_schemas);
    end $$;
    notify pgrst, 'reload config';
  `);

  const { error } = await client.from('apps_tenants').delete().eq('requirement_id', requirement_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function bootstrapAuthForTenant(
  requirement_id: string,
  provider: AppsAuthProvider,
): Promise<{ ok: boolean; instructions?: string; error?: string }> {
  const client = getAppsAdminClient();
  const { error } = await client
    .from('apps_tenants')
    .update({ auth_provider: provider, updated_at: new Date().toISOString() })
    .eq('requirement_id', requirement_id);
  if (error) return { ok: false, error: error.message };

  if (provider === 'supabase') {
    return {
      ok: true,
      instructions:
        'Supabase Auth is the default. Ensure that upon sign-up, the user is immediately synchronized to the current tenant schema users table.',
    };
  }
  return {
    ok: true,
    instructions:
      'Auth0 selected. Configure the Auth0 tenant via dashboard and set APPS_AUTH_PROVIDER=auth0 + AUTH0_* secrets in the sandbox env.',
  };
}
