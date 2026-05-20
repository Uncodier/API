import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const agentsHandler: SystemHealthHandler = {
  systemKey: 'agents',
  label: 'Agents API',
  probePath: '/api/agents/apps/list',
  async runCheck() {
    const start = Date.now();
    const list = await probeHttpRoute('/api/agents/apps/list', { method: 'GET' });
    const supervisor = await probeHttpRoute('/api/agents/supervisor', { method: 'GET' });
    const latencyMs = Date.now() - start;
    const ok = list.status < 500 && supervisor.status < 500;
    return buildHealthResponse({
      systemKey: 'agents',
      label: 'Agents API',
      status: ok ? 'up' : 'down',
      latencyMs,
      summary: ok ? 'Agents routes reachable' : 'Agents routes failing',
      checks: {
        supervisorReachable: supervisor.status < 500,
        sampleRoutes: [
          { path: '/api/agents/apps/list', status: list.status },
          { path: '/api/agents/supervisor', status: supervisor.status },
        ],
      },
      probePath: '/api/agents/apps/list',
    });
  },
};
