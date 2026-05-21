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
        status: 'skipped',
        latencyMs: Date.now() - start,
        summary: 'Apps Supabase not configured',
        checks: { configured: false, schemaProbe: null, latencyMs: 0 },
      });
    }
    try {
      const { getAppsAdminClient } = await import('@/lib/database/apps-supabase');
      const client = getAppsAdminClient();
      const { error } = await client.from('apps_tenants').select('tenant_id').limit(1);
      const latencyMs = Date.now() - start;
      const ok = !error;
      return buildHealthResponse({
        systemKey: 'database_apps',
        label: 'Apps Database',
        status: ok ? 'up' : 'degraded',
        latencyMs,
        summary: ok ? 'Apps registry reachable' : `Apps DB: ${error?.message}`,
        checks: { configured: true, schemaProbe: 'apps_tenants', latencyMs, rowReadable: ok },
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
