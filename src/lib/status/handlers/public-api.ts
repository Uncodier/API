import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

const SAMPLE_ROUTES = ['/api/public/content', '/api/public/posts', '/api/public/rss'];

export const publicApiHandler: SystemHealthHandler = {
  systemKey: 'public_api',
  label: 'Public API',
  async runCheck() {
    const start = Date.now();
    const routes = await Promise.all(
      SAMPLE_ROUTES.map(async (path) => {
        const r = await probeHttpRoute(path, { method: 'GET' });
        return { path, status: r.status, ok: r.ok && r.status < 500 };
      }),
    );
    const failed = routes.filter((r) => !r.ok);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'public_api',
      label: 'Public API',
      status: failed.length === 0 ? 'up' : failed.length === routes.length ? 'down' : 'degraded',
      latencyMs,
      summary: failed.length === 0 ? 'Public routes responding' : `${failed.length}/${routes.length} routes failing`,
      checks: { routes },
    });
  },
};
