import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const workflowHandler: SystemHealthHandler = {
  systemKey: 'workflow',
  label: 'Workflow API',
  probePath: '/api/workflow/execute-node',
  async runCheck() {
    const start = Date.now();
    const execute = await probeHttpRoute('/api/workflow/execute-node', { method: 'GET' });
    const latencyMs = Date.now() - start;
    const contractOk = [200, 400, 401, 405].includes(execute.status);
    return buildHealthResponse({
      systemKey: 'workflow',
      label: 'Workflow API',
      status: contractOk ? 'up' : 'down',
      latencyMs,
      summary: contractOk ? 'Workflow API contract OK' : 'Workflow route error',
      checks: {
        workflowApiReachable: execute.status < 500,
        executeNodeContract: { status: execute.status, expected: '4xx or 200' },
      },
    });
  },
};
