import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const robotsHandler: SystemHealthHandler = {
  systemKey: 'robots',
  label: 'Robots API',
  async runCheck() {
    const start = Date.now();
    const instances = await probeHttpRoute('/api/instances', { method: 'GET' });
    const scrapybaraConfigured = !!(
      process.env.SCRAPYBARA_API_KEY?.trim() || process.env.SCRAPYBARA_API_KEY_ID?.trim()
    );
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'robots',
      label: 'Robots API',
      status: instances.status < 500 ? 'up' : 'degraded',
      latencyMs,
      summary: instances.status < 500 ? 'Instances API reachable' : 'Robots/instances degraded',
      checks: {
        instanceListReachable: instances.status < 500,
        scrapybaraConfigured,
        httpStatus: instances.status,
      },
    });
  },
};
