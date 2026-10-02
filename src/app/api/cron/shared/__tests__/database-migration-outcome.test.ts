jest.mock('@/lib/services/apps-platform/migration-execution', () => ({ loadMigrationExecutionContext: jest.fn(async () => ({ assertCurrent: jest.fn() })) }));
import { databaseMigrationsPassed } from '../database-migration-outcome';
import { applyDatabaseMigrationsStep } from '../step-db-migrations';
import { applyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { logCronInfrastructureEvent } from '@/lib/services/cron-audit-log';

jest.mock('@/lib/services/apps-platform/migration-applier', () => ({ applyPendingMigrations: jest.fn() }));
jest.mock('@/lib/services/sandbox-recovery', () => ({ connectOrRecreateRequirementSandbox: jest.fn() }));
jest.mock('@/lib/services/cron-audit-log', () => ({ logCronInfrastructureEvent: jest.fn() }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));

describe('database migration delivery receipt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (connectOrRecreateRequirementSandbox as jest.Mock).mockResolvedValue({ sandbox: {}, sandboxId: 'recovered' });
  });

  it('requires an explicit successful receipt for app delivery', () => {
    expect(databaseMigrationsPassed(true)).toBe(false);
    expect(databaseMigrationsPassed(true, { status: 'failed', applied: [], errors: ['SQL failed'], failureKind: 'product' })).toBe(false);
    expect(databaseMigrationsPassed(true, { status: 'passed', applied: [], errors: [] })).toBe(true);
    expect(databaseMigrationsPassed(false)).toBe(true);
  });

  it('records a passed receipt even when no new migrations were needed', async () => {
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [] });
    await expect(applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title'))
      .resolves.toEqual({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'recovered' });
  });

  it('preserves product failure classification and persists gate evidence', async () => {
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: ['001.sql'], errors: ['Invalid SQL'], failureKind: 'product' });
    const result = await applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title');
    expect(result).toEqual({ status: 'failed', applied: ['001.sql'], errors: ['Invalid SQL'], failureKind: 'product', effectiveSandboxId: 'recovered' });
    expect(logCronInfrastructureEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({
      level: 'error', details: expect.objectContaining({ status: 'failed', failureKind: 'product' }),
    }));
  });

  it('preserves the recovered sandbox on an infrastructure exception', async () => {
    (applyPendingMigrations as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
    await expect(applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title'))
      .resolves.toMatchObject({ status: 'failed', failureKind: 'infrastructure', effectiveSandboxId: 'recovered' });
  });

  it('preserves the verified pending migration target for bounded repair', async () => {
    const repairTarget = { file: 'supabase/migrations/001.sql', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant', checksum: 'a'.repeat(64), reason: 'lint' };
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: ['RLS'], failureKind: 'product', repairTarget });
    await expect(applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title'))
      .resolves.toMatchObject({ status: 'failed', repairTarget });
  });

  it('enables exact-byte restoration only for an owned gate and logs its separate receipt', async () => {
    const ownership = { requirementId: 'req', runId: 'run', executionGeneration: 2 };
    const restored = [{ file: 'supabase/migrations/001.sql', checksum: 'a'.repeat(64), source: { kind: 'git', revision: 'b'.repeat(40) } }];
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [], restored });
    const result = await applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title', undefined, ownership);
    expect(result).toMatchObject({ status: 'passed', restored, applied: [] });
    expect((applyPendingMigrations as jest.Mock).mock.calls[0][4]).toEqual({ assertCurrent: expect.any(Function) });
    expect(logCronInfrastructureEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({ details: expect.objectContaining({ restored }) }));
    expect(applyDatabaseMigrationsStep.maxRetries).toBe(0);
  });

  it('does not silently grant restoration to an unowned caller', async () => {
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [] });
    await applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title');
    expect((applyPendingMigrations as jest.Mock).mock.calls[0][4]).toBeUndefined();
  });

  it('retains ambiguous recovery diagnostics in the gate failure', async () => {
    const restorationFailure = { file: 'supabase/migrations/001.sql', expectedChecksum: 'a'.repeat(64), actualChecksum: 'b'.repeat(64),
      reason: 'restoration_unverified', writeAttempted: true };
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: ['Recovery unverified'], failureKind: 'infrastructure', restorationFailure });
    expect(await applyDatabaseMigrationsStep('old', 'req', 'applications', 'Title')).toMatchObject({ status: 'failed', restorationFailure });
  });
});