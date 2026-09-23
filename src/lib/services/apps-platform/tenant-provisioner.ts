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
 *   - Registry creation and schema bootstrap are one atomic
 *     `apps_ensure_tenant` RPC. Tenant-authored migrations use the
 *     constrained `apps_apply_migration` RPC.
 *   - Provisioning is serialized per requirement and committed atomically by
 *     the database function.
 */
import { getAppsAdminClient, issueTenantJWT } from '@/lib/database/apps-supabase';
import { syncPostgrestSchemas } from './postgrest-config';

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

function ownerRoleForSchema(schema: string): string {
  return `app_owner_${schema.slice(4)}`;
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

export async function ensureTenant(input: EnsureTenantInput): Promise<EnsureTenantResult> {
  const { requirement_id, user_id, site_id, auth_provider = 'supabase' } = input;
  const client = getAppsAdminClient();
  const candidateTenantId =
    (globalThis.crypto?.randomUUID?.() ?? requirement_id) as string;
  const { data: tenant, error: tenantError } = await client.rpc(
    'apps_ensure_tenant',
    {
      p_requirement_id: requirement_id,
      p_candidate_tenant_id: candidateTenantId,
      p_user_id: user_id,
      p_site_id: site_id,
      p_auth_provider: auth_provider,
    },
  );
  if (tenantError) {
    throw new Error(
      `tenant-provisioner: atomic provisioning failed: ${tenantError.message}`,
    );
  }
  if (!tenant || typeof tenant !== 'object') {
    throw new Error(
      'tenant-provisioner: atomic provisioning returned no receipt.',
    );
  }
  const tenantId = tenant.tenant_id;
  const resolvedSchema = tenant.schema;
  const resolvedBucket = tenant.bucket;
  const resolvedAuthProvider = tenant.auth_provider;
  const created = tenant.created === true;
  if (
    typeof tenantId !== 'string' ||
    typeof resolvedSchema !== 'string' ||
    !/^app_[a-f0-9]{24}$/.test(resolvedSchema) ||
    typeof resolvedBucket !== 'string' ||
    (
      resolvedAuthProvider !== 'supabase' &&
      resolvedAuthProvider !== 'auth0'
    )
  ) {
    throw new Error(
      'tenant-provisioner: atomic provisioning returned an invalid receipt.',
    );
  }
  // Automatically expose the new schema to PostgREST
  const syncResult = await syncPostgrestSchemas();
  if (!syncResult.ok) {
    throw new Error(
      `tenant-provisioner: failed to sync schemas: ${syncResult.error}`,
    );
  }
  const exposeSql = `
    notify pgrst, 'reload config';
    notify pgrst, 'reload schema';
  `;
  const exposeResult = await execSql(exposeSql);
  if (!exposeResult.ok) {
    throw new Error(
      `tenant-provisioner: failed to reload PostgREST: ${exposeResult.error}`,
    );
  }

  const { token, expires_at } = await issueTenantJWT({
    tenant_id: tenantId,
    schema: resolvedSchema,
    user_id,
  });

  return {
    tenant_id: tenantId,
    schema: resolvedSchema,
    bucket: resolvedBucket,
    jwt: token,
    jwt_expires_at: expires_at,
    auth_provider: resolvedAuthProvider,
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
  if (
    typeof row.schema !== 'string' ||
    !/^app_[a-f0-9]{24}$/.test(row.schema)
  ) {
    return { ok: false, error: 'Tenant registry contains an invalid schema.' };
  }
  const ownerRole = ownerRoleForSchema(row.schema);

  const drop = await execSql(`
    drop schema if exists "${row.schema}" cascade;
    do $cleanup$
    begin
      if exists (
        select 1 from pg_catalog.pg_roles where rolname = '${ownerRole}'
      ) then
        execute 'drop owned by "${ownerRole}"';
        execute 'drop role "${ownerRole}"';
      end if;
    end
    $cleanup$;
  `);
  if (!drop.ok) return { ok: false, error: drop.error };

  // Update exposed schemas after dropping
  const syncResult = await syncPostgrestSchemas();
  if (!syncResult.ok) {
    console.warn(`[tenant-provisioner] failed to sync schemas with Supabase Management API after drop: ${syncResult.error}`);
  }
  await execSql(`
    notify pgrst, 'reload config';
    notify pgrst, 'reload schema';
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
