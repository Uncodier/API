import { createClient } from '@supabase/supabase-js';
import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';

export const databaseMainHandler: SystemHealthHandler = {
  systemKey: 'database_main',
  label: 'Main Database',
  probePath: 'supabase:sites',
  async runCheck() {
    const start = Date.now();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return buildHealthResponse({
        systemKey: 'database_main',
        label: 'Main Database',
        status: 'down',
        latencyMs: Date.now() - start,
        summary: 'Missing Supabase configuration',
        checks: { connected: false, tableProbe: 'sites', rowReadable: false },
        error: { code: 'MISSING_CONFIG', message: 'Supabase env vars not set' },
      });
    }
    const supabase = createClient(url, key);
    const { error } = await supabase.from('sites').select('id').limit(1);
    const latencyMs = Date.now() - start;
    const connected = !error;
    return buildHealthResponse({
      systemKey: 'database_main',
      label: 'Main Database',
      status: connected ? 'up' : 'down',
      latencyMs,
      summary: connected ? 'Connected to sites table' : `DB error: ${error?.message}`,
      checks: { connected, tableProbe: 'sites', rowReadable: connected },
      probePath: 'supabase:sites',
      error: error ? { code: 'DB_ERROR', message: error.message } : undefined,
    });
  },
};
