import { verifyDatabaseGate } from '../gates/gate-database';
import { verifyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { loadMigrationExecutionContext } from '@/lib/services/apps-platform/migration-execution';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';
import { verifyDatabaseMigrationsStep } from '../step-db-migration-verification';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';

jest.mock('@/lib/services/apps-platform/migration-applier', () => ({ verifyPendingMigrations: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ listMigrationLifecycle: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-execution', () => ({ loadMigrationExecutionContext: jest.fn(),
  migrationFailure: (error: Error) => ({ error: error.message }) }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));
jest.mock('@/lib/services/sandbox-recovery', () => ({ connectOrRecreateRequirementSandbox: jest.fn() }));
jest.mock('@/lib/services/cron-audit-log', () => ({ logCronInfrastructureEvent: jest.fn() }));

const ownership = { requirementId: 'req', runId: 'run', executionGeneration: 1 };
const sandbox = {} as any;
const context = { requirementId: 'req', assertCurrent: jest.fn() };
const input = { flow: 'app' as const, requirementId: 'req', sandbox, workDir: '/vercel/sandbox',
  audit: { siteId: 'site', executionOwnership: ownership } };

describe('receipt verification is part of the ordinary product gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadMigrationExecutionContext as jest.Mock).mockImplementation(async (_id, assertOwner) => {
      await assertOwner?.(); return context;
    });
    (verifyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [] });
    (connectOrRecreateRequirementSandbox as jest.Mock).mockResolvedValue({ sandbox, sandboxId: 'effective' });
  });

  it('allows product verification only with a matching receipt check', async () => {
    await expect(verifyDatabaseGate(input)).resolves.toBeNull();
    expect(verifyPendingMigrations).toHaveBeenCalledWith(sandbox, 'req', context);
    expect(assertCronExecutionOwnership).toHaveBeenCalledWith(ownership);
  });

  it('returns correction feedback without terminating or scheduling another plan', async () => {
    (verifyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: ['migrations/0003.sql is pending'], failureKind: 'product' });
    await expect(verifyDatabaseGate(input)).resolves.toMatchObject({ ok: false,
      continueImplementation: true, failureKind: 'product_defect', infrastructureFailure: false,
      error: expect.stringContaining('sandbox_db_migrate') });
  });

  it('classifies unavailable receipts as infrastructure, not editable SQL', async () => {
    (verifyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: ['ledger unavailable'], failureKind: 'infrastructure' });
    await expect(verifyDatabaseGate(input)).resolves.toMatchObject({ ok: false,
      continueImplementation: false, infrastructureFailure: true, failureKind: 'infrastructure_unavailable' });
  });

  it.each(['MISSING_MIGRATION', 'APPLIED_MIGRATION_CHANGED'])('directs %s to exact history restoration in the same step, never SQL rewrite or customer permission', async code => {
    (verifyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: ['History mismatch'], failureKind: 'product', diagnostic: { code } });
    const result = await verifyDatabaseGate(input);
    expect(result).toMatchObject({ continueImplementation: true, infrastructureFailure: false });
    expect(result?.error).toContain('exact bytes');
    expect(result?.error).toContain('do not request customer permission');
    expect(result?.error).not.toContain('correct only pending SQL');
  });

  it('does not run verification after ownership fails', async () => {
    (loadMigrationExecutionContext as jest.Mock).mockRejectedValueOnce(new Error('stale owner'));
    await expect(verifyDatabaseGate(input)).resolves.toMatchObject({ ok: false, infrastructureFailure: true });
    expect(verifyPendingMigrations).not.toHaveBeenCalled();
  });

  it('does not accept a nonempty pending list even if the executor returns no error text', async () => {
    (verifyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [], pending: ['migrations/0003.sql'], failureKind: 'product' });
    await expect(verifyDatabaseGate(input)).resolves.toMatchObject({ ok: false, continueImplementation: true });
    await expect(verifyDatabaseMigrationsStep('old', 'req', 'applications', 'App', input.audit, ownership))
      .resolves.toMatchObject({ status: 'failed', errors: [expect.stringContaining('0003')] });
  });

  it('finalization verifies the effective sandbox, with no SQL-application dependency', async () => {
    await expect(verifyDatabaseMigrationsStep('old', 'req', 'applications', 'App', input.audit, ownership))
      .resolves.toEqual({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'effective' });
    expect(verifyPendingMigrations).toHaveBeenCalledWith(sandbox, 'req', context);
  });

  it('keeps delivery failed after a verification exception', async () => {
    (verifyPendingMigrations as jest.Mock).mockRejectedValueOnce(new Error('workspace gone'));
    await expect(verifyDatabaseMigrationsStep('old', 'req', 'applications', 'App', input.audit, ownership))
      .resolves.toMatchObject({ status: 'failed', failureKind: 'infrastructure', errors: ['workspace gone'], effectiveSandboxId: 'effective' });
  });
});