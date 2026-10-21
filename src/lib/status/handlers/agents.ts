import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const agentsHandler: SystemHealthHandler = {
  systemKey: 'agents',
  label: 'Agents API',
  probePath: '/api/agents/apps/list',
  async runCheck() {
    const start = Date.now();
    // Omit site context to avoid Composio calls; GET cannot execute the supervisor.
    const list = await probeHttpRoute('/api/agents/apps/list', {
      method: 'GET',
      expectedStatuses: [400],
      validateResponse: (body, headers) => {
        if (!headers.get('content-type')?.includes('application/json')) return false;
        const result = JSON.parse(body);
        return result?.success === false && result.error === 'site_id is required';
      },
    });
    const supervisor = await probeHttpRoute('/api/agents/supervisor', {
      method: 'GET', expectedStatuses: [405],
    });
    const latencyMs = Date.now() - start;
    const ok = list.ok && supervisor.ok;
    return buildHealthResponse({
      systemKey: 'agents',
      label: 'Agents API',
      status: ok ? 'up' : 'down',
      latencyMs,
      summary: ok ? 'Agents negative route contracts verified; execution unverified' : 'Agents route contract checks failed',
      checks: {
        verification: 'contract',
        functionalVerified: false,
        supervisorMethodContract: supervisor.ok,
        sampleRoutes: [
          { path: '/api/agents/apps/list', status: list.status, expectedStatuses: [400], ok: list.ok },
          { path: '/api/agents/supervisor', status: supervisor.status, expectedStatuses: [405], ok: supervisor.ok },
        ],
      },
      probePath: '/api/agents/apps/list',
    });
  },
};
