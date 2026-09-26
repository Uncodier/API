import { jest } from '@jest/globals';
const getAppsAdminClient = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('@/lib/database/apps-supabase', () => ({ getAppsAdminClient }));

const tenant = {
  tenant_id: '00000000-0000-4000-8000-000000000003',
  schema: 'app_aaaaaaaabbbb4ccc8dddeeee',
};

describe('Apps database health', () => {
  let databaseAppsHandler: typeof import('@/lib/status/handlers/database-apps').databaseAppsHandler;
  const originalUrl = process.env.APPS_SUPABASE_URL;
  const originalKey = process.env.APPS_SUPABASE_SERVICE_KEY;

  beforeAll(async () => {
    ({ databaseAppsHandler } = await import('@/lib/status/handlers/database-apps'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APPS_SUPABASE_URL = 'https://apps.example.test';
    process.env.APPS_SUPABASE_SERVICE_KEY = 'test-service-key';
  });

  afterAll(() => {
    if (originalUrl === undefined) delete process.env.APPS_SUPABASE_URL;
    else process.env.APPS_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.APPS_SUPABASE_SERVICE_KEY;
    else process.env.APPS_SUPABASE_SERVICE_KEY = originalKey;
  });

  it('does not report up just because the registry exists when migration RPC is missing', async () => {
    getAppsAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ limit: async () => ({ data: [tenant], error: null }) }) }),
      rpc: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        data: null,
        error: { code: 'PGRST202', message: 'apps_get_migration_receipt was not found' },
      }),
    });

    const health = await databaseAppsHandler.runCheck();
    expect(health.status).toBe('down');
    expect(health.summary).toContain('apps_get_migration_receipt');
    expect(health.checks).toMatchObject({ rowReadable: true, migrationRpcAvailable: false });
  });

  it('reports up after a read-only migration receipt probe succeeds', async () => {
    const rpc = jest.fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ data: { found: false }, error: null });
    getAppsAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ limit: async () => ({ data: [tenant], error: null }) }) }),
      rpc,
    });

    const health = await databaseAppsHandler.runCheck();
    expect(health.status).toBe('up');
    expect(health.checks).toMatchObject({ migrationRpcAvailable: true });
    expect(rpc).toHaveBeenCalledWith('apps_get_migration_receipt', {
      p_target_schema: tenant.schema,
      p_expected_tenant_id: tenant.tenant_id,
      p_migration_key: 'migration:health-check.sql',
    });
  });
});