import {
  getAppsAdminClient,
  issueTenantJWT,
} from '@/lib/database/apps-supabase';
import { ensureTenant } from '../tenant-provisioner';
import { syncPostgrestSchemas } from '../postgrest-config';
import { ensureTenantStorage } from '../tenant-storage';

jest.mock('../tenant-storage', () => ({
  ...jest.requireActual('../tenant-storage'), ensureTenantStorage: jest.fn(),
}));

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

const capabilityReceipt = {
  version: 1, requirement_id: requirementId,
  tenant_id: '00000000-0000-4000-8000-000000000003', schema: 'app_aaaaaaaabbbb4ccc8dddeeee',
  identity: { user_id: 'app_aaaaaaaabbbb4ccc8dddeeee._app_current_user_id', claims: 'app_aaaaaaaabbbb4ccc8dddeeee._app_request_claims', backend: 'app_aaaaaaaabbbb4ccc8dddeeee._app_is_backend_request' },
  storage: { available: false, bucket: null }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] },
};
const readyReceipt = { ...capabilityReceipt, storage: { available: true, bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee' } };

const bindingQuery = (overrides: Record<string, unknown> = {}) => () => ({ select: () => ({ eq: () => ({
  maybeSingle: async () => ({ data: { tenant_id: capabilityReceipt.tenant_id, schema: capabilityReceipt.schema,
    user_id: input.user_id, site_id: input.site_id, status: 'active', ...overrides }, error: null }),
}) }) });

describe('tenant provisioner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ensureTenantStorage as jest.Mock).mockResolvedValue({ bucket: readyReceipt.storage.bucket, created: false });
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
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery() });

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
        : name === 'apps_ensure_tenant_capabilities' ? { data: capabilityReceipt, error: null }
        : name === 'apps_get_tenant_capabilities' ? { data: readyReceipt, error: null }
        : { data: null, error: null });
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery() });

    const result = await ensureTenant(input);

    expect(result).toEqual(expect.objectContaining({
      tenant_id: winner.tenant_id,
      schema: winner.schema,
      created: false,
      capabilities: readyReceipt,
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
    expect(ensureTenantStorage).toHaveBeenCalledWith({ requirementId,
      tenantId: winner.tenant_id, schema: winner.schema, bucket: winner.bucket,
      userId: input.user_id, siteId: input.site_id }, expect.anything());
    expect((ensureTenantStorage as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((issueTenantJWT as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('fails before issuing a JWT when schema exposure fails', async () => {
    const tenant = {
      tenant_id: '00000000-0000-4000-8000-000000000003',
      schema: 'app_aaaaaaaabbbb4ccc8dddeeee',
      bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee',
      auth_provider: 'supabase',
      created: true,
    };
    const rpc = jest.fn(async (name: string) => ({ data: name === 'apps_ensure_tenant_capabilities' ? capabilityReceipt : name === 'apps_get_tenant_capabilities' ? readyReceipt : tenant, error: null }));
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery() });
    (syncPostgrestSchemas as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'management API unavailable',
    });

    await expect(ensureTenant(input)).rejects.toThrow(
      'failed to sync schemas',
    );
    expect(issueTenantJWT).not.toHaveBeenCalled();
  });

  it('fails closed before issuing credentials when capability provisioning is unavailable', async () => {
    const tenant = { tenant_id: capabilityReceipt.tenant_id, schema: capabilityReceipt.schema,
      bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee', auth_provider: 'supabase', created: false };
    const rpc = jest.fn(async (name: string) => name === 'apps_ensure_tenant'
      ? { data: tenant, error: null }
      : { data: null, error: { code: 'PGRST202' } });
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc });
    await expect(ensureTenant(input)).rejects.toThrow('capability provisioning failed');
    expect(issueTenantJWT).not.toHaveBeenCalled();
    expect(syncPostgrestSchemas).not.toHaveBeenCalled();
  });

  it('refuses to issue a backend token for a different registry subject', async () => {
    const tenant = { tenant_id: capabilityReceipt.tenant_id, schema: capabilityReceipt.schema,
      bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee', auth_provider: 'supabase', created: false };
    const rpc = jest.fn(async (name: string) => ({ data: name === 'apps_ensure_tenant_capabilities' ? capabilityReceipt : tenant, error: null }));
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery({ user_id: 'another-user' }) });
    await expect(ensureTenant(input)).rejects.toThrow('backend identity binding do not match');
    expect(issueTenantJWT).not.toHaveBeenCalled();
    expect(ensureTenantStorage).not.toHaveBeenCalled();
  });

  it.each(['stale_receipt', 'refresh_error'])('does not block DB/Auth after optional Storage %s', async failure => {
    const tenant = { tenant_id: capabilityReceipt.tenant_id, schema: capabilityReceipt.schema,
      bucket: readyReceipt.storage.bucket, auth_provider: 'supabase', created: false };
    const rpc = jest.fn(async (name: string) => ({
      data: name === 'apps_ensure_tenant' ? tenant : name === 'apps_get_tenant_capabilities' && failure !== 'stale_receipt' ? readyReceipt : capabilityReceipt,
      error: name === 'apps_get_tenant_capabilities' && failure === 'refresh_error' ? { code: 'unavailable' } : null,
    }));
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery() });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await ensureTenant(input)).capabilities.storage).toEqual({ available: false, bucket: null });
      expect(issueTenantJWT).toHaveBeenCalled();
      expect(syncPostgrestSchemas).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('still rejects identity metadata changes during capability refresh', async () => {
    const tenant = { tenant_id: capabilityReceipt.tenant_id, schema: capabilityReceipt.schema,
      bucket: readyReceipt.storage.bucket, auth_provider: 'supabase', created: false };
    const rpc = jest.fn(async (name: string) => ({ data: name === 'apps_ensure_tenant' ? tenant
      : name === 'apps_get_tenant_capabilities' ? { ...readyReceipt, tenant_id: input.user_id } : capabilityReceipt, error: null }));
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery() });
    await expect(ensureTenant(input)).rejects.toThrow('Tenant capability receipt');
    expect(issueTenantJWT).not.toHaveBeenCalled();
  });

  it('keeps DB/Auth provisioning usable but hides Storage when its preflight or API fails', async () => {
    const tenant = { tenant_id: capabilityReceipt.tenant_id, schema: capabilityReceipt.schema,
      bucket: readyReceipt.storage.bucket, auth_provider: 'supabase', created: false };
    const rpc = jest.fn(async (name: string) => ({ data: name === 'apps_ensure_tenant' ? tenant : readyReceipt, error: null }));
    (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc, from: bindingQuery() });
    (ensureTenantStorage as jest.Mock).mockRejectedValue(new Error('private provider detail'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ensureTenant(input);
      expect(result.capabilities.storage).toEqual({ available: false, bucket: null });
      expect(result.capabilities.identity).toEqual(capabilityReceipt.identity);
      expect(issueTenantJWT).toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalledWith('apps_get_tenant_capabilities', expect.anything());
      expect(warn).toHaveBeenCalledWith('[tenant-provisioner] Storage unavailable', {
        requirement_id: requirementId, code: 'provisioning_failed',
      });
    } finally { warn.mockRestore(); }
  });
});
