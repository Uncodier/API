import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutionRouting, getCustomerOperationKey, withCustomerOperation } from '../customer-routing';
import { runGateProbesStep } from '@/app/api/cron/shared/step-gate-probes-step';
import { resolveCustomerCredential } from '@/lib/integrations/openrouter/store';
import { runRuntimeAndVisualProbes } from '@/app/api/cron/shared/step-gate-probes';
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn() }));
jest.mock('@/lib/services/sandbox-recovery', () => ({ connectOrRecreateRequirementSandbox: jest.fn(async () => ({ sandboxId: 'offline', sandbox: {} })) }));
jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/offline' } }));
jest.mock('@/app/api/cron/shared/step-gate-probes', () => ({ runRuntimeAndVisualProbes: jest.fn() }));
jest.mock('@/app/api/cron/shared/step-interaction-runner', () => ({ runInteractionAudit: async () => ({ ok: true }) }));
jest.mock('@/app/api/cron/shared/step-interaction-backlog', () => ({ applyInteractionBacklogPolicy: async () => ({ ok: true }) }));
const siteId = randomUUID();
const routing = { payer: 'customer' as const, siteId, connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 };
const params = { sandboxId: 'offline', stepOrder: 0, requirementId: randomUUID(),
  gitRepoKind: 'applications' as const, instanceType: 'applications', title: 'Offline',
  changeBaselineSha: 'baseline', audit: { siteId, instanceId: randomUUID() },
  executionRouting: routing, inferenceOperationId: 'maintenance:stable:probe' };
beforeEach(() => { jest.clearAllMocks(); jest.mocked(resolveCustomerCredential).mockResolvedValue({} as any); });

it('restores the pinned customer and durable operation at a real independent visual-probe step', async () => {
  jest.mocked(runRuntimeAndVisualProbes).mockImplementation(async () => {
    expect(getExecutionRouting()).toEqual(routing);
    expect(getCustomerOperationKey()).toBe('maintenance:stable:probe:0');
    return { ok: true, signals: {} };
  });
  await withCustomerOperation('parent-http', () => runGateProbesStep(params));
  await runGateProbesStep(params);
  expect(runRuntimeAndVisualProbes).toHaveBeenCalledTimes(2);
  expect(getExecutionRouting()).toBeUndefined();
});

it('revoked durable pin never executes a visual provider or reselects platform', async () => {
  jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('revoked'));
  await expect(runGateProbesStep(params)).rejects.toThrow('revoked');
  expect(runRuntimeAndVisualProbes).not.toHaveBeenCalled();
});

const source = (path: string) => readFileSync(join(process.cwd(), 'src/app/api', path), 'utf8');
it('pins both active maintenance passes and update-repo delegation, with step-local restore', () => {
  expect(source('agents/tools/update_repo/core.ts')).toContain('executionRouting: getExecutionRouting(site_id)');
  expect(source('agents/tools/update_repo/workflow.ts')).toContain('executionRouting: input.executionRouting');
  expect(source('cron/maintenance/route.ts')).toContain('executionRouting: await admitAssistantRouting(site_id)');
  expect(source('cron/maintenance/workflow.ts').match(/executionRouting: input.executionRouting/g)).toHaveLength(4);
  for (const file of ['agents/tools/update_repo/agent-step.ts', 'cron/maintenance/agent-step.ts', 'cron/shared/step-gate-probes-step.ts']) {
    const text = source(file);
    expect(text).toContain('withExecutionRouting(params.executionRouting');
    expect(text).toContain('durableBoundary: true');
    expect(text.split('\n').length).toBeLessThan(500);
  }
});

it('the active requirement cron dispatches the canonical session-backed assistant, not retired legacy phases', () => {
  expect(source('cron/requirements-apps/workflow.ts')).toContain('executeRequirementCycle(run)');
  expect(source('cron/requirements-apps/agent-step.ts')).toContain('runRequirementCycle(run)');
  expect(source('cron/requirements-apps/route.ts')).not.toContain('cron-execute-steps-phase');
});