import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
const getSandboxHandle = jest.fn<(...args: any[]) => Promise<any>>();
const ensurePlatformKeyForRequirement = jest.fn<(...args: any[]) => Promise<any>>();
const ensureTenant = jest.fn<(...args: any[]) => Promise<any>>();
const pushVercelBranchEnv = jest.fn<(...args: any[]) => Promise<any>>();
const from = jest.fn();
const getAppsPublicConfig = jest.fn<(...args: any[]) => any>();

const input = {
  sandboxId: 'sandbox-1',
  requirementId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  siteId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000001',
  instanceId: '00000000-0000-4000-8000-000000000003',
  branchName: 'feature/requirement',
};

const tenant = {
  tenant_id: '00000000-0000-4000-8000-000000000004',
  schema: 'app_aaaaaaaabbbb4ccc8dddeeee',
  bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee',
  auth_provider: 'supabase',
  created: false,
  jwt: 'sandbox-jwt',
  jwt_expires_at: '2026-10-01T00:00:00Z',
};

describe('platform key / tenant preflight', () => {
  let provisionPlatformKeyStep: typeof import('../platform-key-step').provisionPlatformKeyStep;

  beforeAll(async () => {
    ({ provisionPlatformKeyStep } = loadRuntimeModule<typeof import('../platform-key-step')>(
      'src/app/api/cron/shared/platform-key-step.ts', {
        '@/lib/services/sandbox-sdk': { getSandboxHandle },
        '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/vercel/sandbox' } },
        '@/lib/services/platform-api/ensure-platform-key': { ensurePlatformKeyForRequirement },
        '@/lib/services/apps-platform/tenant-provisioner': { ensureTenant },
        '@/lib/database/apps-supabase': { getAppsPublicConfig },
        '@/lib/database/supabase-client': { supabaseAdmin: { from } },
        '@/lib/services/vercel-env': { pushVercelBranchEnv },
        '@/lib/utils/token-decryption': { decryptToken: jest.fn() },
      },
    ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getSandboxHandle.mockResolvedValue({
      runCommand: jest.fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValueOnce({ stdout: async () => 'NO\n' })
        .mockResolvedValue({ exitCode: 0 }),
    });
    ensurePlatformKeyForRequirement.mockResolvedValue({
      key_id: 'key-1',
      created: true,
      expires_at: '2026-10-01T00:00:00Z',
      api_key: null,
    });
    getAppsPublicConfig.mockReturnValue({
      url: 'https://apps.example.test',
      anonKey: 'public-key',
    });
    from.mockReturnValue({
      select: () => ({
        eq: () => ({ or: async () => ({ data: [], error: null }) }),
      }),
    });
  });

  it('stops application work instead of running without the tenant', async () => {
    ensureTenant.mockRejectedValue(new Error('apps_ensure_tenant RPC not found'));

    await expect(provisionPlatformKeyStep({ ...input, authProvider: 'supabase' }))
      .rejects.toThrow('apps_ensure_tenant RPC not found');
    expect(ensureTenant).toHaveBeenCalledWith(expect.objectContaining({
      requirement_id: input.requirementId,
    }));
    expect(pushVercelBranchEnv).not.toHaveBeenCalled();
  });

  it('continues without provisioning for flows that do not require a tenant', async () => {
    const result = await provisionPlatformKeyStep({ ...input, authProvider: null });
    expect(result.tenant).toBeUndefined();
    expect(ensureTenant).not.toHaveBeenCalled();
  });

  it('does not continue with un-injected tenant env when sandbox writes fail', async () => {
    ensureTenant.mockResolvedValue(tenant);
    getSandboxHandle.mockResolvedValue({
      runCommand: jest.fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValueOnce({ stdout: async () => 'NO\n' })
        .mockResolvedValueOnce({ exitCode: 1 }),
    });

    await expect(provisionPlatformKeyStep({ ...input, authProvider: 'supabase' }))
      .rejects.toThrow('Failed to write sandbox .env.local (exit 1)');
    expect(pushVercelBranchEnv).not.toHaveBeenCalled();
  });

  it('rejects tenant-backed flows without Apps public credentials', async () => {
    ensureTenant.mockResolvedValue(tenant);
    getAppsPublicConfig.mockReturnValue({ url: 'https://apps.example.test', anonKey: '' });

    await expect(provisionPlatformKeyStep({ ...input, authProvider: 'supabase' }))
      .rejects.toThrow('Apps Supabase anon key is required');
  });

  it('injects the existing tenant into a healthy application sandbox', async () => {
    ensureTenant.mockResolvedValue(tenant);
    const result = await provisionPlatformKeyStep({ ...input, authProvider: 'supabase' });

    expect(result.tenant).toMatchObject({ schema: tenant.schema, tenant_id: tenant.tenant_id });
    expect(result.injected_env_keys).toEqual(expect.arrayContaining([
      'NEXT_PUBLIC_APPS_SUPABASE_URL',
      'NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_APPS_TENANT_SCHEMA',
      'APPS_TENANT_JWT',
    ]));
    expect(pushVercelBranchEnv).toHaveBeenCalledWith(
      input.branchName,
      expect.objectContaining({
        NEXT_PUBLIC_APPS_TENANT_SCHEMA: tenant.schema,
        APPS_TENANT_JWT: tenant.jwt,
      }),
      'applications',
    );
  });
});