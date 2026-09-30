import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { parseTenantCapabilities, type TenantCapabilities } from './tenant-capabilities';
import { verifyTenantStorage, TenantStorageError } from './tenant-storage';

/** Read-only discovery bound to trusted requirement context, never an agent-selected tenant. */
export async function getTenantCapabilities(requirementId: string): Promise<TenantCapabilities> {
  const apps = getAppsAdminClient();
  const { data: tenant, error } = await apps.from('apps_tenants')
    .select('tenant_id, schema, bucket, status').eq('requirement_id', requirementId).maybeSingle();
  if (error || !tenant || tenant.status !== 'active') {
    throw new Error('Tenant capability lookup unavailable: active tenant not confirmed.');
  }
  const { data, error: rpcError } = await apps.rpc('apps_get_tenant_capabilities', {
    p_requirement_id: requirementId, p_expected_tenant_id: tenant.tenant_id,
  });
  if (rpcError) throw new Error(`Tenant capabilities unavailable (${rpcError.code || 'lookup_failed'}). Platform provisioning must repair the missing capability.`);
  const capabilities = parseTenantCapabilities(data, { requirementId, tenantId: tenant.tenant_id, schema: tenant.schema, bucket: tenant.bucket });
  if (capabilities.storage.available) {
    try {
      await verifyTenantStorage({ requirementId, tenantId: tenant.tenant_id, schema: tenant.schema, bucket: tenant.bucket }, apps);
    } catch (error) {
      // A bucket row alone is not readiness. Keep DB capabilities usable, fail Storage closed.
      console.warn('[tenant-capabilities] Storage verification failed:', error instanceof TenantStorageError ? error.code : 'verification_failed');
      capabilities.storage = { available: false, bucket: null };
    }
  }
  return capabilities;
}