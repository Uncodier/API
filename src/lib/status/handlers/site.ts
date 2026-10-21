import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const siteHandler: SystemHealthHandler = {
  systemKey: 'site',
  label: 'Site API',
  probePath: '/api/site/requirements',
  async runCheck() {
    const start = Date.now();
    // Missing required parameters must fail before any analysis or DB work.
    const req = await probeHttpRoute('/api/site/requirements', {
      method: 'GET',
      expectedStatuses: [400],
      validateResponse: (body, headers) => {
        if (!headers.get('content-type')?.includes('application/json')) return false;
        const result = JSON.parse(body);
        return result?.error === 'Parámetros inválidos' && Array.isArray(result.details) &&
          ['url', 'segment_id'].every((field) => result.details.some(
            (detail: { path?: unknown[] }) => Array.isArray(detail?.path) && detail.path[0] === field,
          ));
      },
    });
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'site',
      label: 'Site API',
      status: req.ok ? 'up' : 'down',
      latencyMs,
      summary: req.ok ? 'Site validation contract verified; analysis and DB read unverified' : 'Site route contract check failed',
      checks: {
        verification: 'contract',
        functionalVerified: false,
        requirementsRouteContract: { status: req.status, expectedStatuses: [400], ok: req.ok },
      },
    });
  },
};
