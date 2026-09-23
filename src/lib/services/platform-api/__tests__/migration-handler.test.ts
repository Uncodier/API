import { resolveHandler } from '../handlers';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));
jest.mock('@/lib/database/apps-supabase', () => ({
  getAppsAdminClient: jest.fn(),
}));

const context = {
  site_id: '00000000-0000-4000-8000-000000000001',
  requirement_id: '00000000-0000-4000-8000-000000000002',
  api_key_id: 'key-1',
  scopes: ['db.migrate'],
  test_only: false,
  capability: 'db',
  scope: 'db.migrate',
};

function request(body: Record<string, unknown>) {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as any;
}

function migrationHandler() {
  const entry = resolveHandler('POST', ['db', 'migrations']);
  if (!entry) throw new Error('Migration handler is not registered');
  return entry.handler;
}

describe('platform migration handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires a stable migration name', async () => {
    const result = await migrationHandler()(
      request({ sql: 'ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;' }),
      context,
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toContain('stable migration name');
    expect(getAppsAdminClient).not.toHaveBeenCalled();
  });

  it('uses the supplied name as the immutable ledger identity', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        tenant_id: '00000000-0000-4000-8000-000000000003',
        schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa',
        bucket: 'tenant-aaaaaaaaaaaaaaaaaaaaaaaa',
      },
      error: null,
    });
    (getAppsAdminClient as jest.Mock).mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
      rpc,
    });

    const result = await migrationHandler()(
      request({
        name: '20260923_campaigns.sql',
        sql: 'ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;',
      }),
      context,
    );

    expect(result.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'apps_apply_migration',
      expect.objectContaining({
        p_migration_key:
          'migration:platform/20260923_campaigns.sql',
      }),
    );
  });
});
