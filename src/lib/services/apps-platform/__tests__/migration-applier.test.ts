import { createHash } from 'node:crypto';
import { applyPendingMigrations } from '../migration-applier';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { syncPostgrestSchemas } from '../postgrest-config';
import { authorizeMigrationApplication, loadMigrationApplicationContext } from '../migration-application-guard';
jest.mock('../migration-application-guard', () => ({ authorizeMigrationApplication: jest.fn(), loadMigrationApplicationContext: jest.fn() }));
jest.mock('../migration-lifecycle', () => ({ transitionMigrationLifecycle: jest.fn(async input => ({ ...input.value, version: 2 })) }));

jest.mock('@/lib/database/apps-supabase', () => ({
  getAppsAdminClient: jest.fn(),
}));
jest.mock('../postgrest-config', () => ({
  syncPostgrestSchemas: jest.fn(),
}));

const requirementId = '12345678-1234-1234-1234-123456789012';
const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
const migrationFile = 'supabase/migrations/001_create_campaigns.sql';
const migrationSql = 'ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;';

function sandbox(
  files = [migrationFile],
  sqlByFile: Record<string, string> = { [migrationFile]: migrationSql },
) {
  return {
    runCommand: jest.fn(async (command: string, args: string[]) => {
      if (command === 'realpath') return { exitCode: 0, stdout: jest.fn().mockResolvedValue(args[1]) };
      if (command === 'sh') {
        return {
          exitCode: 0,
          stdout: jest.fn().mockResolvedValue(`${files.join('\n')}\n`),
        };
      }
      return {
        exitCode: 0,
        stdout: jest.fn().mockResolvedValue(sqlByFile[args[0]] ?? ''),
      };
    }),
  } as any;
}

function client(
  metaRow: unknown,
  metaError: unknown = null,
  applyResult: boolean | null = true,
) {
  const db = {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn().mockResolvedValue({
            data: { tenant_id: 'tenant-123', schema },
            error: null,
          }),
        })),
      })),
    })),
    rpc: jest.fn(async (name: string) => {
      if (name === 'apps_get_migration_receipt') {
        return {
          data: metaRow
            ? { found: true, value: (metaRow as any).value }
            : { found: false },
          error: metaError,
        };
      }
      return name === 'apps_apply_migration'
        ? { data: applyResult, error: null }
        : { data: null, error: null };
    }),
  };
  return { db, rpc: db.rpc };
}

describe('applyPendingMigrations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (syncPostgrestSchemas as jest.Mock).mockResolvedValue({ ok: true });
    (loadMigrationApplicationContext as jest.Mock).mockResolvedValue({ executionGeneration: 1, assertCurrent: jest.fn() });
    (authorizeMigrationApplication as jest.Mock).mockResolvedValue({ allowed: true, lifecycle: { version: 1, attempts: 1 } });
  });

  it('reads the ledger through the protected RPC and skips applied SQL', async () => {
    const checksum = createHash('sha256').update(migrationSql).digest('hex');
    const mocked = client({
      key: `migration:${migrationFile}`,
      value: { checksum },
    });
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(sandbox(), requirementId);

    expect(result).toEqual({ applied: [], errors: [] });
    expect(mocked.rpc).toHaveBeenCalledWith(
      'apps_get_migration_receipt',
      expect.objectContaining({ p_target_schema: schema }),
    );
    expect(mocked.rpc).not.toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.anything(),
    );
    expect(syncPostgrestSchemas).toHaveBeenCalled();
  });

  it('refuses to rerun a migration whose applied checksum changed', async () => {
    const mocked = client({
      key: `migration:${migrationFile}`,
      value: { checksum: 'different-checksum' },
    });
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(sandbox(), requirementId);

    expect(result.applied).toEqual([]);
    expect(result.errors[0]).toContain('changed after it was applied');
    expect(result.errors[0]).toContain('Restore the exact applied file bytes');
    expect(result.errors[0]).toContain('earliest Git commit is not proof');
    expect(result.errors[0]).toContain('Never change the ledger checksum');
    expect(result.failureKind).toBe('product');
    expect(result.repairTarget).toBeUndefined();
    expect(mocked.rpc).not.toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.anything(),
    );
  });

  it('backfills a legacy ledger row without rerunning its migration', async () => {
    const mocked = client({
      key: `migration:${migrationFile}`,
      value: { applied_at: '2026-09-20T00:00:00.000Z' },
    }, null, false);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(sandbox(), requirementId);

    expect(result).toEqual({ applied: [], errors: [] });
    expect(mocked.rpc).toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.objectContaining({
        p_migration_key: `migration:${migrationFile}`,
      }),
    );
    expect(syncPostgrestSchemas).toHaveBeenCalled();
  });

  it('uses the atomic migration RPC for a new migration', async () => {
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(sandbox(), requirementId);

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([migrationFile]);
    expect(mocked.rpc).toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.objectContaining({
        p_target_schema: schema,
        p_expected_tenant_id: 'tenant-123',
        p_migration_key: `migration:${migrationFile}`,
        p_migration_checksum: createHash('sha256')
          .update(migrationSql)
          .digest('hex'),
        p_migration_sql: migrationSql,
      }),
    );
  });

  it('cannot apply a normal executor file that independent review rejected', async () => {
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);
    (authorizeMigrationApplication as jest.Mock).mockResolvedValue({ allowed: false, error: 'Preserve ownership', lifecycle: { state: 'correction_required', file: migrationFile } });
    const result = await applyPendingMigrations(sandbox(), requirementId);
    expect(result.correction).toMatchObject({ state: 'correction_required' });
    expect(mocked.rpc).not.toHaveBeenCalledWith('apps_apply_migration', expect.anything());
  });

  it('aborts when a file changes after independent review', async () => {
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);
    const files = { [migrationFile]: migrationSql };
    (authorizeMigrationApplication as jest.Mock).mockImplementation(async params => {
      files[migrationFile] += '-- changed';
      await params.assertUnchanged();
      return { allowed: true };
    });
    const result = await applyPendingMigrations(sandbox([migrationFile], files), requirementId);
    expect(result.errors).toEqual([expect.stringContaining('changed during')]);
    expect(mocked.rpc).not.toHaveBeenCalledWith('apps_apply_migration', expect.anything());
  });

  it('preserves the first atomic receipt when review of a later file throws', async () => {
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);
    (authorizeMigrationApplication as jest.Mock).mockResolvedValueOnce({ allowed: true, lifecycle: { version: 1 } })
      .mockRejectedValueOnce(new Error('review transport unavailable'));
    const next = 'migrations/0002.sql';
    const result = await applyPendingMigrations(sandbox([migrationFile, next], { [migrationFile]: migrationSql, [next]: migrationSql }), requirementId);
    expect(result.applied).toEqual([migrationFile]);
    expect(result.errors).toEqual([expect.stringContaining('review transport unavailable')]);
    expect(result.failureKind).toBe('infrastructure');
  });

  it('retries exposure when another caller already applied the migration', async () => {
    const mocked = client(null, null, false);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(sandbox(), requirementId);

    expect(result).toEqual({ applied: [], errors: [] });
    expect(syncPostgrestSchemas).toHaveBeenCalled();
  });

  it('fails closed when the tenant ledger cannot be read', async () => {
    const mocked = client(null, { message: 'schema unavailable' });
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(sandbox(), requirementId);

    expect(result.errors).toEqual([
      expect.stringContaining('schema unavailable'),
    ]);
    expect(mocked.rpc).not.toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.anything(),
    );
  });

  it('does not apply later migrations after an earlier migration fails', async () => {
    const first = 'supabase/migrations/001_invalid.sql';
    const second = 'supabase/migrations/002_valid.sql';
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);

    const result = await applyPendingMigrations(
      sandbox(
        [first, second],
        {
          [first]: 'DROP SCHEMA public;',
          [second]: migrationSql,
        },
      ),
      requirementId,
    );

    expect(result.errors[0]).toContain('failed linting');
    expect(result.repairTarget).toEqual({
      file: first, schema, tenantId: 'tenant-123', reason: 'lint',
      checksum: createHash('sha256').update('DROP SCHEMA public;').digest('hex'),
    });
    expect(mocked.rpc).not.toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.anything(),
    );
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['42601', 'product', true], ['23503', 'product', true],
    ['42501', 'infrastructure', false], ['PGRST202', 'infrastructure', false],
  ])('classifies SQLSTATE %s and limits automatic repair to SQL defects', async (code, failureKind, repairable) => {
    const mocked = client(null);
    mocked.rpc.mockImplementation(async (name: string): Promise<any> => name === 'apps_get_migration_receipt'
      ? { data: { found: false }, error: null }
      : { data: null, error: { code, message: 'Failure' } });
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);
    const result = await applyPendingMigrations(sandbox(), requirementId);
    expect(result.failureKind).toBe(failureKind);
    expect(!!result.repairTarget).toBe(repairable);
  });

  it('does not edit product SQL to work around a simultaneous exposure failure', async () => {
    const first = 'supabase/migrations/001.sql';
    const second = 'supabase/migrations/002.sql';
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);
    (syncPostgrestSchemas as jest.Mock).mockResolvedValue({ ok: false, error: 'API unavailable' });
    const result = await applyPendingMigrations(sandbox([first, second], {
      [first]: migrationSql, [second]: 'DROP SCHEMA public;',
    }), requirementId);
    expect(result.applied).toEqual([first]);
    expect(result.errors).toHaveLength(2);
    expect(result.failureKind).toBe('infrastructure');
    expect(result.repairTarget).toBeUndefined();
  });

  it('fails closed if recovery loses a repaired file, even with an empty migration batch', async () => {
    const mocked = client(null);
    (getAppsAdminClient as jest.Mock).mockReturnValue(mocked.db);
    const expected = { file: migrationFile, schema, tenantId: 'tenant-123',
      checksum: createHash('sha256').update(migrationSql).digest('hex'), reason: 'lint' as const };
    const lost = await applyPendingMigrations(sandbox([], {}), requirementId, [expected]);
    expect(lost.failureKind).toBe('infrastructure');
    expect(lost.errors[0]).toContain('missing or changed');
    expect(mocked.rpc).not.toHaveBeenCalled();
    const undiscovered = await applyPendingMigrations(sandbox([], { [migrationFile]: migrationSql }), requirementId, [expected]);
    expect(undiscovered.errors[0]).toContain('absent from the discovered');
    const withoutReceipt = await applyPendingMigrations(sandbox(), requirementId, [expected]);
    expect(withoutReceipt.errors[0]).toContain('no matching atomic receipt');
    mocked.rpc.mockImplementation(async (name: string): Promise<any> => name === 'apps_get_migration_receipt'
      ? { data: { found: true, value: { checksum: expected.checksum } }, error: null }
      : { data: null, error: null });
    const valid = await applyPendingMigrations(sandbox(), requirementId, [expected]);
    expect(valid.applied).toEqual([]);
    expect(valid.errors).toEqual([]);
  });
});
