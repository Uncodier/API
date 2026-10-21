import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const robotsHandler: SystemHealthHandler = {
  systemKey: 'robots',
  label: 'Robots API',
  async runCheck() {
    const start = Date.now();
    const instances = await probeHttpRoute('/api/instances', {
      method: 'GET',
      expectedStatuses: [200],
      validateResponse: (body, headers) => {
        if (!headers.get('content-type')?.includes('application/json')) return false;
        return Array.isArray(JSON.parse(body)?.instances);
      },
    });
    const scrapybaraConfigured = !!(
      process.env.SCRAPYBARA_API_KEY?.trim() || process.env.SCRAPYBARA_API_KEY_ID?.trim()
    );
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'robots',
      label: 'Robots API',
      status: instances.ok ? 'up' : 'down',
      latencyMs,
      summary: instances.ok ? 'Instances list response verified; robot execution unverified' : 'Instances list probe failed',
      checks: {
        verification: 'response',
        robotExecutionVerified: false,
        instanceListResponseVerified: instances.ok,
        scrapybaraConfigured,
        httpStatus: instances.status,
      },
    });
  },
};
