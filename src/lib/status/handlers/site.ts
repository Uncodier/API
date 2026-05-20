import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const siteHandler: SystemHealthHandler = {
  systemKey: 'site',
  label: 'Site API',
  probePath: '/api/site/requirements',
  async runCheck() {
    const start = Date.now();
    const req = await probeHttpRoute('/api/site/requirements', { method: 'GET' });
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'site',
      label: 'Site API',
      status: req.status < 500 ? 'up' : 'down',
      latencyMs,
      summary: req.status < 500 ? 'Site requirements route OK' : 'Site API failing',
      checks: { requirementsRoute: { status: req.status }, supabaseRead: true },
    });
  },
};
