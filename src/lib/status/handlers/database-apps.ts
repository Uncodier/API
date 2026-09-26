import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';

export const databaseAppsHandler: SystemHealthHandler = {
  systemKey: 'database_apps',
  label: 'Apps Database',
  probePath: 'apps-supabase',
  async runCheck() {
    const start = Date.now();
    const url = process.env.APPS_SUPABASE_URL || process.env.REPOSITORY_SUPABASE_URL;
    const key =
      process.env.APPS_SUPABASE_SERVICE_KEY || process.env.REPOSITORY_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return buildHealthResponse({
        systemKey: 'database_apps',
        label: 'Apps Database',
        status: 'down',
        latencyMs: Date.now() - start,
        summary: 'Apps Supabase not configured',
        checks: { configured: false, schemaProbe: null, latencyMs: 0 },
      });
    }
    try {
      const { getAppsAdminClient } = await import('@/lib/database/apps-supabase');
      const client = getAppsAdminClient();
      const { data: tenants, error } = await client
        .from('apps_tenants')
        .select('tenant_id, schema')
        .limit(1);
      const latencyMs = Date.now() - start;
      if (error) {
        return buildHealthResponse({
          systemKey: 'database_apps',
          label: 'Apps Database',
          status: 'down',
          latencyMs,
          summary: `Apps DB: ${error.message}`,
          checks: { configured: true, schemaProbe: 'apps_tenants', latencyMs, rowReadable: false },
        });
      }
      const tenant = tenants?.find((row) =>
        typeof row.tenant_id === 'string' &&
        typeof row.schema === 'string' &&
        /^app_[a-f0-9]{24}$/.test(row.schema),
      );
      if (!tenant) {
        return buildHealthResponse({
          systemKey: 'database_apps',
          label: 'Apps Database',
          status: 'down',
          latencyMs,
          summary: 'Apps registry reachable; no tenant available to verify migration RPC',
          checks: { configured: true, schemaProbe: 'apps_tenants', latencyMs, rowReadable: true, migrationRpcAvailable: null },
        });
      }

      // A non-existent ledger key is a read-only capability probe. Never call
      // apps_ensure_tenant/apps_apply_migration from health checks: both mutate.
      const { data: receipt, error: rpcError } = await client.rpc(
        'apps_get_migration_receipt',
        {
          p_target_schema: tenant.schema,
          p_expected_tenant_id: tenant.tenant_id,
          p_migration_key: 'migration:health-check.sql',
        },
      );
      const rpcAvailable = !rpcError && receipt && typeof receipt.found === 'boolean';
      return buildHealthResponse({
        systemKey: 'database_apps',
        label: 'Apps Database',
        status: rpcAvailable ? 'up' : 'down',
        latencyMs: Date.now() - start,
        summary: rpcAvailable
          ? 'Apps registry and migration receipt RPC reachable'
          : `Apps registry reachable; apps_get_migration_receipt unavailable${rpcError?.code ? ` (${rpcError.code})` : ''}`,
        checks: { configured: true, schemaProbe: 'apps_tenants', latencyMs: Date.now() - start, rowReadable: true, migrationRpcAvailable: !!rpcAvailable },
      });
    } catch (err) {
      return buildHealthResponse({
        systemKey: 'database_apps',
        label: 'Apps Database',
        status: 'down',
        latencyMs: Date.now() - start,
        summary: err instanceof Error ? err.message : 'Apps DB probe failed',
        checks: { configured: true, schemaProbe: 'apps_tenants', latencyMs: Date.now() - start },
      });
    }
  },
};
