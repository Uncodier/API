import { createHash } from 'node:crypto';
import { authorizeMigrationApplication } from '@/lib/services/apps-platform/migration-application-guard';
import { listMigrationLifecycle, transitionMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';
import { reviewMigrationSecurity } from '@/lib/services/apps-platform/migration-security-review';
import { getTenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities-service';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ listMigrationLifecycle: jest.fn(), transitionMigrationLifecycle: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-security-review', () => ({ reviewMigrationSecurity: jest.fn() }));
jest.mock('@/lib/services/apps-platform/tenant-capabilities-service', () => ({ getTenantCapabilities: jest.fn() }));

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sql = 'CREATE TABLE records (id uuid, user_id uuid); ALTER TABLE records ENABLE ROW LEVEL SECURITY; CREATE POLICY own_records ON records USING (user_id = _app_current_user_id());';
const target = { file: 'migrations/0001.sql', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant', checksum: digest(sql), reason: 'lint' as const };
const context = { requirementId: 'req', executionGeneration: 4, specification: 'Users own records.', specificationChecksum: digest('Users own records.'),
  instance: { site_id: 'site', requirement_id: 'req' }, assertCurrent: jest.fn(async () => {}) };
const existing = { requirement_id: 'req', file: target.file, version: 2, state: 'correction_required', checksum: target.checksum,
  specification_checksum: context.specificationChecksum, original_sql: 'DO $$ BEGIN NULL; END $$;', reason: 'Static SQL required', review: null, attempts: 1 };

describe('central migration application review', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([]);
    (transitionMigrationLifecycle as jest.Mock).mockImplementation(async input => ({ ...input.value, requirement_id: input.requirementId, file: input.file, version: input.expectedVersion + 1 }));
    (getTenantCapabilities as jest.Mock).mockResolvedValue({ schema: target.schema, tenant_id: target.tenantId });
    (reviewMigrationSecurity as jest.Mock).mockResolvedValue({ decision: 'approved_for_validation', reason: 'Preserves specified ownership.' });
  });

  it('persists review and validation intent before returning authorization for new SQL', async () => {
    const unchanged = jest.fn(async () => {});
    const result = await authorizeMigrationApplication({ context, target, sql, assertUnchanged: unchanged });
    expect(result).toMatchObject({ allowed: true, lifecycle: { state: 'validation_pending' } });
    expect((transitionMigrationLifecycle as jest.Mock).mock.calls.map(call => call[0].value.state)).toEqual(['reviewing','validation_pending']);
    expect(reviewMigrationSecurity).toHaveBeenCalledWith(expect.objectContaining({ proposedSql: sql, reviewMode: 'application', specification: context.specification }));
    expect(unchanged).toHaveBeenCalledTimes(1);
  });

  it('routes forbidden dynamic SQL to correction without spending reviewer turns', async () => {
    const rejected = 'DO $$ BEGIN NULL; END $$;';
    const result = await authorizeMigrationApplication({ context, target: { ...target, checksum: digest(rejected) }, sql: rejected, assertUnchanged: jest.fn() });
    expect(result).toMatchObject({ allowed: false, lifecycle: { state: 'correction_required' } });
    expect(reviewMigrationSecurity).not.toHaveBeenCalled();
  });

  it('reviews a corrected file from any writer against the original rejected SQL', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([existing]);
    await authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() });
    expect(reviewMigrationSecurity).toHaveBeenCalledWith(expect.objectContaining({ originalSql: existing.original_sql, proposedSql: sql }));
  });

  it.each(['request_changes','platform_review'] as const)('persists a %s verdict and refuses application', async decision => {
    (reviewMigrationSecurity as jest.Mock).mockResolvedValue({ decision, reason: 'Needs work' });
    const result = await authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() });
    expect(result.allowed).toBe(false);
    expect(result.lifecycle.state).toBe(decision === 'request_changes' ? 'correction_required' : 'platform_review');
  });

  it('cannot silently repeat an interrupted review or exhausted correction budget', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...existing, state: 'reviewing' }]);
    expect((await authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() })).lifecycle.state).toBe('platform_review');
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...existing, attempts: 5 }]);
    expect((await authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() })).lifecycle.state).toBe('platform_review');
    expect(reviewMigrationSecurity).not.toHaveBeenCalled();
  });

  it('retains the reviewing intent when provider or post-review file validation fails', async () => {
    (reviewMigrationSecurity as jest.Mock).mockRejectedValueOnce(new Error('provider down'));
    await expect(authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() })).rejects.toThrow('provider down');
    expect(transitionMigrationLifecycle).toHaveBeenCalledTimes(1);
    (reviewMigrationSecurity as jest.Mock).mockResolvedValue({ decision: 'approved_for_validation', reason: 'Reviewed' });
    await expect(authorizeMigrationApplication({ context, target, sql, assertUnchanged: async () => { throw new Error('file changed'); } })).rejects.toThrow('file changed');
    expect((transitionMigrationLifecycle as jest.Mock).mock.calls.every(call => call[0].value.state === 'reviewing')).toBe(true);
  });

  it('invalidates pending verification if SQL or specification changes', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...existing, state: 'validation_pending', checksum: 'b'.repeat(64) }]);
    const result = await authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() });
    expect(result).toMatchObject({ allowed: false, lifecycle: { state: 'platform_review' } });
    expect(reviewMigrationSecurity).not.toHaveBeenCalled();
  });

  it('never reuses a validation receipt from a different tenant registry binding', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...existing, state: 'validation_pending', review: {
      binding: { tenant_id: 'other-tenant', schema: target.schema, checksum: target.checksum, specification_checksum: context.specificationChecksum },
    } }]);
    expect((await authorizeMigrationApplication({ context, target, sql, assertUnchanged: jest.fn() })).allowed).toBe(false);
    expect(reviewMigrationSecurity).not.toHaveBeenCalled();
  });
});