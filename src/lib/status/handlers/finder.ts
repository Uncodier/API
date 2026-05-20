import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const finderHandler: SystemHealthHandler = {
  systemKey: 'finder',
  label: 'Finder API',
  async runCheck() {
    const start = Date.now();
    const r = await probeHttpRoute('/api/finder/person_role_search/totals', { method: 'GET' });
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'finder',
      label: 'Finder API',
      status: r.status < 500 ? 'up' : 'down',
      latencyMs,
      summary: r.status < 500 ? 'Finder route contract OK' : 'Finder API failing',
      checks: { searchRouteContract: { path: '/api/finder/person_role_search/totals', status: r.status } },
    });
  },
};
