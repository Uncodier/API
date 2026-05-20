import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { createClient } from '@supabase/supabase-js';

export const platformHandler: SystemHealthHandler = {
  systemKey: 'platform',
  label: 'Platform API',
  async runCheck() {
    const start = Date.now();
    let auditTableReachable = false;
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (url && key) {
        const supabase = createClient(url, key);
        const { error } = await supabase.from('platform_audit_log').select('id').limit(1);
        auditTableReachable = !error || error.code === 'PGRST116';
      }
    } catch {
      auditTableReachable = false;
    }
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'platform',
      label: 'Platform API',
      status: auditTableReachable ? 'up' : 'degraded',
      latencyMs,
      summary: auditTableReachable ? 'Platform tables reachable' : 'Platform audit table not verified',
      checks: { handlersLoaded: true, auditTableReachable },
    });
  },
};
