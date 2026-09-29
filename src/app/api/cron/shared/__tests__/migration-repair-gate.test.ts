import { runGateStep } from '../gate-step-executor';
import { runGateForFlow } from '../gates';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';
import { verifyMigrationRepairFiles } from '@/lib/services/apps-platform/migration-repair-files';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({
  single: async () => ({ data: { steps: [{ id: 'step', status: 'completed' }, { id: 'next', status: 'pending' }] } }),
}) }) }) } }));
jest.mock('../gates', () => ({ runGateForFlow: jest.fn() }));
jest.mock('../step-archetype-postgate', () => ({ runArchetypePostGate: jest.fn() }));
jest.mock('@/lib/services/cron-audit-log', () => ({ CronInfraEvent: {}, logCronInfrastructureEvent: jest.fn() }));
jest.mock('@/lib/services/sandbox-recovery', () => ({ connectOrRecreateRequirementSandbox: async () => ({ sandbox: {}, sandboxId: 'recovered' }) }));
jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));
jest.mock('@/lib/services/sandbox-sdk', () => ({ sandboxIdentity: () => 'replacement' }));
jest.mock('../gate-failure-healing', () => ({ applyGateFailureHealing: jest.fn() }));
jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({ patchPlanStepAtomically: jest.fn() }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-repair-files', () => ({ verifyMigrationRepairFiles: jest.fn() }));
jest.mock('../single-turn-gate-context', () => ({ loadBacklogGateContext: async () => ({ acceptance: ['Authorized read'], acceptanceContract: { schema_version: 2 } }) }));
jest.mock('../commit/pre-push-build-validation', () => ({ computeApplicationBuildFingerprint: async () => 'fresh-tree' }));
jest.mock('../single-turn-helpers', () => ({
  getDeclaredProtectedRoutes: () => ['/dashboard'], getDeclaredTestCommand: () => 'npm test',
  getDeclaredValidationTargets: () => ['api'],
}));

describe('fresh product gate after SQL repair', () => {
  const ownership = { requirementId: 'req', runId: 'run', executionGeneration: 3 };
  const params = {
    sandboxId: 'old', plan: { id: 'plan', title: 'Plan' },
    step: { id: 'step', order: 1, title: 'Work', instructions: 'Verify work', metadata: { backlog_item_id: 'item' } },
    requirementId: 'req', instanceId: 'instance', siteId: 'site', userId: 'user', title: 'App',
    instanceType: 'applications', requirementType: 'app', freshMigrationValidation: true, executionOwnership: ownership,
    expectedRepairs: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (runGateForFlow as jest.Mock).mockResolvedValue({ ok: true, richSignals: {} });
  });

  it('passes complete fresh app context without cached receipts or mutation tools', async () => {
    await expect(runGateStep(params)).resolves.toMatchObject({ passed: true, effectiveSandboxId: 'recovered' });
    expect(runGateForFlow).toHaveBeenCalledWith(expect.objectContaining({
      flow: 'app', audit: expect.objectContaining({ executionOwnership: ownership }),
      appContext: expect.objectContaining({
        planTitle: 'Plan', stepId: 'step', workspaceFingerprint: 'fresh-tree',
        validationScope: 'intermediate', validateDeployment: false, fullTools: [],
        stepContext: expect.objectContaining({ test_command: 'npm test', acceptance: ['Authorized read'] }),
      }),
    }));
    expect((runGateForFlow as jest.Mock).mock.calls[0][0].appContext.reusableValidation).toBeUndefined();
    expect(assertCronExecutionOwnership).toHaveBeenCalledTimes(3);
    expect(verifyMigrationRepairFiles).toHaveBeenCalledTimes(2);
  });

  it('preserves infrastructure failure instead of accepting unverified repairs', async () => {
    (runGateForFlow as jest.Mock).mockResolvedValue({ ok: false, infrastructureFailure: true, error: 'probe unavailable' });
    await expect(runGateStep(params)).resolves.toMatchObject({ passed: false, infrastructureFailure: true, effectiveSandboxId: 'recovered' });
  });

  it('classifies an exception during fresh verification as infrastructure, never product proof', async () => {
    (runGateForFlow as jest.Mock).mockRejectedValueOnce(new Error('probe transport unavailable'));
    await expect(runGateStep(params)).resolves.toMatchObject({ passed: false, infrastructureFailure: true, error: 'probe transport unavailable' });
  });
});