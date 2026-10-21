import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const finderHandler: SystemHealthHandler = {
  systemKey: 'finder',
  label: 'Finder API',
  async runCheck() {
    const start = Date.now();
    // POST is billable; only verify GET is rejected by this POST-only route.
    const r = await probeHttpRoute('/api/finder/person_role_search/totals', {
      method: 'GET', expectedStatuses: [405],
    });
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'finder',
      label: 'Finder API',
      status: r.ok ? 'up' : 'down',
      latencyMs,
      summary: r.ok ? 'Finder method contract verified; search unverified' : 'Finder route contract check failed',
      checks: {
        verification: 'contract',
        functionalVerified: false,
        searchRouteContract: {
          path: '/api/finder/person_role_search/totals', status: r.status, expectedStatuses: [405], ok: r.ok,
        },
      },
    });
  },
};
