import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const visitorsHandler: SystemHealthHandler = {
  systemKey: 'visitors',
  label: 'Visitors API',
  probePath: '/api/visitors/identify',
  async runCheck() {
    const start = Date.now();
    // Middleware owns CORS OPTIONS, so it cannot prove route registration.
    // Also verify the POST-only route's safe GET rejection; never identify a visitor.
    const [r, preflight] = await Promise.all([
      probeHttpRoute('/api/visitors/identify', { method: 'GET', expectedStatuses: [405] }),
      probeHttpRoute('/api/visitors/identify', {
        method: 'OPTIONS', expectedStatuses: [204],
        validateResponse: (body, headers) => body === '' &&
          (headers.get('access-control-allow-methods') ?? headers.get('allow') ?? '')
            .split(',').map(method => method.trim()).includes('POST'),
      }),
    ]);
    const ok = r.ok && preflight.ok;
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'visitors',
      label: 'Visitors API',
      status: ok ? 'up' : 'down',
      latencyMs,
      summary: ok ? 'Visitors route and CORS contracts verified; identification unverified' : 'Visitors route or CORS contract check failed',
      checks: {
        verification: 'contract',
        functionalVerified: false,
        identifyRouteContract: { ok: r.ok, status: r.status, expectedStatuses: [405] },
        identifyOptionsContract: { ok: preflight.ok, status: preflight.status, expectedStatuses: [204] },
      },
    });
  },
};

