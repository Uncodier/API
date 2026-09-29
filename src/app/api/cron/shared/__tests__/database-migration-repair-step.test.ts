import { repairDatabaseMigrationStep } from '../step-db-migration-repair';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { createMigrationRepairTools } from '@/lib/services/apps-platform/migration-repair-tools';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';
import { logCronInfrastructureEvent } from '@/lib/services/cron-audit-log';
import { getTenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities-service';

jest.mock('@/lib/services/robot-instance/assistant-executor', () => ({ executeAssistantStep: jest.fn() }));
jest.mock('@/lib/services/sandbox-recovery', () => ({ connectOrRecreateRequirementSandbox: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-repair-tools', () => ({ createMigrationRepairTools: jest.fn() }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn(), isCronExecutionOwnershipError: () => false }));
jest.mock('@/lib/services/cron-audit-log', () => ({ logCronInfrastructureEvent: jest.fn() }));
jest.mock('@/lib/services/apps-platform/tenant-capabilities-service', () => ({ getTenantCapabilities: jest.fn() }));

const params = {
  sandboxId: 'old', requirementId: 'req', instanceType: 'applications', title: 'Title',
  audit: { instanceId: 'instance', siteId: 'site', userId: 'user' },
  executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 3 },
  outcome: { status: 'failed' as const, applied: [], errors: ['Unsafe policy'], failureKind: 'product' as const,
    repairTarget: { file: 'supabase/migrations/0001.sql', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant', checksum: 'a'.repeat(64), reason: 'lint' as const } },
  attempt: 1, maxAttempts: 5, messages: [],
};

describe('durable migration repair step', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (connectOrRecreateRequirementSandbox as jest.Mock).mockResolvedValue({ sandbox: {}, sandboxId: 'recovered' });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ isDone: true, messages: [{ role: 'assistant', content: 'Claimed done' }] });
    (createMigrationRepairTools as jest.Mock).mockReturnValue({ tools: [{ name: 'restricted-tool' }], wasChanged: () => false, repairedTarget: () => undefined });
    (getTenantCapabilities as jest.Mock).mockResolvedValue({ schema: params.outcome.repairTarget.schema, tenant_id: params.outcome.repairTarget.tenantId });
  });

  it('does not run repair against unverified capabilities or another tenant', async () => {
    (getTenantCapabilities as jest.Mock).mockRejectedValue(new Error('capability unavailable'));
    await expect(repairDatabaseMigrationStep(params)).resolves.toMatchObject({ changed: false, error: expect.stringContaining('capability unavailable') });
    expect(executeAssistantStep).not.toHaveBeenCalled();
    (getTenantCapabilities as jest.Mock).mockResolvedValue({ schema: 'other', tenant_id: 'other' });
    await expect(repairDatabaseMigrationStep(params)).resolves.toMatchObject({ changed: false, error: expect.stringContaining('does not match') });
  });

  it('uses only restricted tools, exact ownership and one tool attempt', async () => {
    const result = await repairDatabaseMigrationStep(params);
    expect(result).toMatchObject({ changed: false, done: true, effectiveSandboxId: 'recovered' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(executeAssistantStep).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), expect.objectContaining({
      enforceSingleTurn: true, use_sdk_tools: false, custom_tools: [{ name: 'restricted-tool' }],
      system_prompt: expect.stringContaining('Never claim delivery'),
    }));
    expect(assertCronExecutionOwnership).toHaveBeenCalledTimes(3);
    expect(logCronInfrastructureEvent).toHaveBeenCalledWith(params.audit, expect.objectContaining({
      details: expect.objectContaining({ failureKind: 'product', attempt: 1, changed: false }),
    }));
    expect(repairDatabaseMigrationStep.maxRetries).toBe(0);
  });

  it('does not treat assistant success prose as a write receipt', async () => {
    await expect(repairDatabaseMigrationStep(params)).resolves.toMatchObject({ changed: false });
  });

  it('does not run for an applied migration or infrastructure failure', async () => {
    await repairDatabaseMigrationStep({ ...params, outcome: { ...params.outcome, repairTarget: undefined } });
    await repairDatabaseMigrationStep({ ...params, outcome: { ...params.outcome, failureKind: 'infrastructure' } });
    expect(executeAssistantStep).not.toHaveBeenCalled();
    expect(connectOrRecreateRequirementSandbox).not.toHaveBeenCalled();
  });

  it('propagates ownership loss and does not replay an ambiguous assistant write', async () => {
    (assertCronExecutionOwnership as jest.Mock).mockRejectedValue(new Error('stale owner'));
    await expect(repairDatabaseMigrationStep(params)).rejects.toThrow('stale owner');
    expect(executeAssistantStep).not.toHaveBeenCalled();
    (assertCronExecutionOwnership as jest.Mock).mockResolvedValue(undefined);
    (executeAssistantStep as jest.Mock).mockRejectedValue(new Error('transport failed'));
    await expect(repairDatabaseMigrationStep(params)).resolves.toMatchObject({ changed: false, error: expect.stringContaining('transport failed'), effectiveSandboxId: 'recovered' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
  });
});