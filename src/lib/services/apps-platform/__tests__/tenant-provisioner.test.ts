import {
  getAppsAdminClient,
  issueTenantJWT,
} from '@/lib/database/apps-supabase';
import { ensureTenant } from '../tenant-provisioner';
import { syncPostgrestSchemas } from '../postgrest-config';

jest.mock('@/lib/database/apps-supabase', () => ({
  getAppsAdminClient: jest.fn(),
  issueTenantJWT: jest.fn(),
}));
jest.mock('../postgrest-config', () => ({
  syncPostgrestSchemas: jest.fn(),
}));

const requirementId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const input = {
  requirement_id: requirementId,
  user_id: '00000000-0000-4000-8000-000000000001',
  site_id: '00000000-0000-4000-8000-000000000002',
} as const;

describe('tenant provisioner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (syncPostgrestSchemas as jest.Mock).mockResolvedValue({ ok: true });
    (issueTenantJWT as jest.Mock).mockResolvedValue({
      token: 'tenant-token',
      expires_at: '2026-09-24T00:00:00.000Z',
    });
  });

  it('does not issue a JWT when atomic provisioning fails', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'baseline rejected' },
    });
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc });

    await expect(ensureTenant(input)).rejects.toThrow(
      'atomic provisioning failed: baseline rejected',
    );
    expect(issueTenantJWT).not.toHaveBeenCalled();
  });

  it('uses the receipt from the atomic concurrent provisioning RPC', async () => {
    const winner = {
      tenant_id: '00000000-0000-4000-8000-000000000003',
      schema: 'app_aaaaaaaabbbb4ccc8dddeeee',
      bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee',
      auth_provider: 'supabase',
      created: false,
    };
    const rpc = jest.fn(async (name: string) =>
      name === 'apps_ensure_tenant'
        ? { data: winner, error: null }
        : { data: null, error: null });
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc });

    const result = await ensureTenant(input);

    expect(result).toEqual(expect.objectContaining({
      tenant_id: winner.tenant_id,
      schema: winner.schema,
      created: false,
    }));
    expect(rpc).toHaveBeenCalledWith(
      'apps_ensure_tenant',
      expect.objectContaining({
        p_requirement_id: requirementId,
      }),
    );
    expect(issueTenantJWT).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: winner.tenant_id,
      schema: winner.schema,
    }));
  });

  it('fails before issuing a JWT when schema exposure fails', async () => {
    const tenant = {
      tenant_id: '00000000-0000-4000-8000-000000000003',
      schema: 'app_aaaaaaaabbbb4ccc8dddeeee',
      bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee',
      auth_provider: 'supabase',
      created: true,
    };
    const rpc = jest.fn().mockResolvedValue({
      data: tenant,
      error: null,
    });
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc });
    (syncPostgrestSchemas as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'management API unavailable',
    });

    await expect(ensureTenant(input)).rejects.toThrow(
      'failed to sync schemas',
    );
    expect(issueTenantJWT).not.toHaveBeenCalled();
  });
});
