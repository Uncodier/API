import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const workflowHandler: SystemHealthHandler = {
  systemKey: 'workflow',
  label: 'Workflow API',
  probePath: '/api/workflow/execute-node',
  async runCheck() {
    const start = Date.now();
    // Unsupported GET verifies dispatch without executing nodes or invoking AI.
    const execute = await probeHttpRoute('/api/workflow/execute-node', {
      method: 'GET', expectedStatuses: [405],
    });
    const latencyMs = Date.now() - start;
    const contractOk = execute.ok;
    return buildHealthResponse({
      systemKey: 'workflow',
      label: 'Workflow API',
      status: contractOk ? 'up' : 'down',
      latencyMs,
      summary: contractOk ? 'Workflow method contract verified; execution unverified' : 'Workflow route contract check failed',
      checks: {
        verification: 'contract',
        functionalVerified: false,
        executeNodeContract: { status: execute.status, expectedStatuses: [405], ok: execute.ok },
      },
    });
  },
};
