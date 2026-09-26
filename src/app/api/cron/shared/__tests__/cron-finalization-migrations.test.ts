import { createFinalStatusStep } from '../cron-workflow-finalize';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { finalizeRequirementExecution } from '@/lib/services/requirement-finalization';
import type { DatabaseMigrationOutcome } from '../database-migration-outcome';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/requirement-finalization', () => ({ finalizeRequirementExecution: jest.fn() }));
jest.mock('@/lib/services/requirement-flow-engine', () => ({ canCloseRequirement: jest.fn(async () => ({ ok: true })) }));
jest.mock('@/lib/services/sandbox-sdk', () => ({ getSandboxHandle: jest.fn() }));
jest.mock('@/lib/services/sandbox-lifecycle', () => ({ shouldTakeManualEndOfWorkflowSnapshot: () => false }));
jest.mock('@/lib/services/cron-audit-log', () => ({ CronInfraEvent: { FINAL_STATUS: 'final' }, logCronInfrastructureEvent: jest.fn() }));
jest.mock('@/lib/services/requirement-git-binding', () => ({ getRequirementGitBinding: jest.fn() }));
jest.mock('@/lib/services/sandbox-persisted-snapshot', () => ({ deleteSnapshotQuiet: jest.fn() }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));

const params = {
  site_id: 'site', instanceId: 'instance', reqId: 'req', flowKind: 'app',
  didPush: true, planCompleted: true, repoOk: true, previewOk: true,
  repoUrl: 'https://github.com/org/repo/tree/feature', previewUrl: 'https://preview.example.com',
  sourceCodeUrl: 'https://storage.example.com/source.zip', expectedExecutionGeneration: 1, cycleId: 'cycle',
};

describe('final delivery requires migration success', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const result = { data: table === 'requirements' ? { metadata: { requirement_execution_generation: 1 } } : null, error: null };
      const query: any = { maybeSingle: jest.fn(async () => result), single: jest.fn(async () => result) };
      for (const method of ['select', 'eq', 'order', 'limit']) query[method] = jest.fn(() => query);
      return query;
    });
    (finalizeRequirementExecution as jest.Mock).mockImplementation(async input => ({ state: 'applied', effectiveStatus: input.status }));
  });

  it.each([undefined, { status: 'failed', applied: [], errors: ['SQL failed'], failureKind: 'product' }] as Array<DatabaseMigrationOutcome | undefined>)(
    'does not finalize done with missing or failed migrations (%j)', async databaseMigrations => {
      await expect(createFinalStatusStep({ ...params, databaseMigrations })).resolves.toMatchObject({ effectiveStatus: 'in-progress' });
      expect(finalizeRequirementExecution).toHaveBeenCalledWith(expect.objectContaining({
        isComplete: false, message: expect.stringContaining('database migrations'),
      }));
    },
  );

  it('can complete when every gate including migrations passes', async () => {
    await expect(createFinalStatusStep({ ...params, databaseMigrations: { status: 'passed', applied: [], errors: [] } }))
      .resolves.toMatchObject({ effectiveStatus: 'done' });
  });

  it('does not require an application migration receipt for document flows', async () => {
    await expect(createFinalStatusStep({ ...params, flowKind: 'doc' })).resolves.toMatchObject({ effectiveStatus: 'done' });
  });

  it('revalidates the owner while allowing the preceding wrap-up review status', async () => {
    await createFinalStatusStep({ ...params, flowKind: 'doc', audit: {
      siteId: 'site', executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 1 },
    } });
    expect(assertCronExecutionOwnership).toHaveBeenCalledTimes(2);
    expect(assertCronExecutionOwnership).toHaveBeenLastCalledWith({
      requirementId: 'req', runId: 'run', executionGeneration: 1, allowTerminal: true,
    });
  });
});