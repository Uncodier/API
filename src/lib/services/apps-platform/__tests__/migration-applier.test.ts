import { createHash } from 'node:crypto';
import { applyPendingMigrations } from '../migration-applier';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { syncPostgrestSchemas } from '../postgrest-config';

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
    expect(mocked.rpc).not.toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.anything(),
    );
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
  });
});
