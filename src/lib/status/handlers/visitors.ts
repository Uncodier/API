import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const visitorsHandler: SystemHealthHandler = {
  systemKey: 'visitors',
  label: 'Visitors API',
  probePath: '/api/visitors/identify',
  async runCheck() {
    const start = Date.now();
    const r = await probeHttpRoute('/api/visitors/identify', { method: 'OPTIONS' });
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'visitors',
      label: 'Visitors API',
      status: r.status < 500 ? 'up' : 'down',
      latencyMs,
      summary: r.status < 500 ? 'Visitors API reachable' : 'Visitors API failing',
      checks: { identifyRouteReachable: r.status < 500, httpStatus: r.status },
    });
  },
};

