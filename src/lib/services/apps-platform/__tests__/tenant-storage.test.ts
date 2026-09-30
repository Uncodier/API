import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureTenantStorage, getTenantStorageConfig, TenantStorageError, verifyTenantStorage } from '../tenant-storage';
import { getTenantCapabilities } from '../tenant-capabilities-service';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));

const binding = {
  requirementId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  tenantId: '00000000-0000-4000-8000-000000000001',
  schema: 'app_aaaaaaaabbbb4ccc8dddeeee', bucket: 'tenant-aaaaaaaabbbb4ccc8dddeeee',
  userId: '00000000-0000-4000-8000-000000000002', siteId: '00000000-0000-4000-8000-000000000003',
};
const config = { version: 1, policy_version: 1, status: 'active',
  requirement_id: binding.requirementId, tenant_id: binding.tenantId, schema: binding.schema,
  bucket: binding.bucket, user_id: binding.userId, site_id: binding.siteId,
  file_size_limit: 10485760, allowed_mime_types: ['image/png', 'text/plain'] };
const bucket = { id: binding.bucket, name: binding.bucket, public: false,
  file_size_limit: config.file_size_limit, allowed_mime_types: config.allowed_mime_types };
const missing = { statusCode: '404', message: 'Bucket not found' };

function mockClient() {
  const rpc = jest.fn().mockResolvedValue({ data: config, error: null });
  const storage = {
    getBucket: jest.fn().mockResolvedValue({ data: bucket, error: null }),
    createBucket: jest.fn().mockResolvedValue({ data: { name: bucket.name }, error: null }),
  };
  const client = { rpc, storage } as unknown as SupabaseClient;
  return { client, rpc, storage };
}

describe('platform-only tenant Storage provisioning', () => {
  it('preserves typed errors when compiled to the repository ES5 target', () => {
    expect(new TenantStorageError('bucket_missing')).toBeInstanceOf(TenantStorageError);
    expect(new TenantStorageError('bucket_missing')).toBeInstanceOf(Error);
  });
  it('creates only the bound private bucket after policy preflight and verifies it', async () => {
    const { client, rpc, storage } = mockClient();
    storage.getBucket.mockResolvedValueOnce({ data: null, error: missing });
    expect(await ensureTenantStorage(binding, client)).toEqual({ bucket: bucket.id, created: true });
    expect(storage.createBucket).toHaveBeenCalledWith(bucket.id, {
      public: false, fileSizeLimit: config.file_size_limit, allowedMimeTypes: config.allowed_mime_types,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(storage.createBucket.mock.invocationCallOrder[0]);
  });

  it('is idempotent and preserves stricter existing limits', async () => {
    const { client, storage } = mockClient();
    storage.getBucket.mockResolvedValue({ data: { ...bucket, file_size_limit: 1024, allowed_mime_types: ['image/png'] }, error: null });
    for (let n = 0; n < 2; n++) expect(await ensureTenantStorage(binding, client)).toEqual({ bucket: bucket.id, created: false });
    expect(storage.createBucket).not.toHaveBeenCalled();
  });

  it.each([
    { statusCode: '409', message: 'The resource already exists' },
    { statusCode: 'BucketAlreadyExists', message: 'conflict' },
  ])('handles a concurrent creator only after verifying the winning bucket (%j)', async error => {
    const { client, storage } = mockClient();
    storage.getBucket.mockResolvedValueOnce({ data: null, error: missing });
    storage.createBucket.mockResolvedValue({ data: null, error });
    expect(await ensureTenantStorage(binding, client)).toEqual({ bucket: bucket.id, created: false });
    expect(storage.getBucket).toHaveBeenCalledTimes(2);
  });

  it.each([{ statusCode: '403', message: 'Forbidden' }, { status: 404, message: 'proxy not found' },
    { statusCode: '500', message: 'unavailable' }, { message: 'timeout' }])('does not create on lookup failure %j', async error => {
    const { client, storage } = mockClient();
    storage.getBucket.mockResolvedValue({ data: null, error });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('bucket_lookup_failed');
    expect(storage.createBucket).not.toHaveBeenCalled();
  });

  it.each([{ public: true }, { id: 'workspaces' }, { name: 'workspaces' },
    { file_size_limit: null }, { file_size_limit: 10485761 }, { file_size_limit: 0 },
    { allowed_mime_types: null }, { allowed_mime_types: [] }, { allowed_mime_types: ['text/html'] }])('fails closed on unsafe bucket %j', async patch => {
    const { client, storage } = mockClient();
    storage.getBucket.mockResolvedValue({ data: { ...bucket, ...patch }, error: null });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('bucket_configuration_mismatch');
    expect(storage.createBucket).not.toHaveBeenCalled();
  });

  it.each([{ bucket: 'workspaces' }, { requirement_id: binding.tenantId }, { tenant_id: binding.userId },
    { schema: 'public' }, { status: 'suspended' }, { user_id: binding.siteId },
    { site_id: binding.userId }, { policy_version: 2 }, { file_size_limit: 0 },
    { allowed_mime_types: ['*/*'] }])('rejects untrusted config %j before any Storage request', async patch => {
    const { client, rpc, storage } = mockClient();
    rpc.mockResolvedValue({ data: { ...config, ...patch }, error: null });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('invalid_config');
    expect(storage.getBucket).not.toHaveBeenCalled();
  });

  it('rejects arbitrary destinations without even invoking the config RPC', async () => {
    const { client, rpc } = mockClient();
    await expect(ensureTenantStorage({ ...binding, bucket: 'workspaces' }, client)).rejects.toThrow('invalid_binding');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not disclose provider errors or fields outside the receipt allowlist', async () => {
    const { client, rpc, storage } = mockClient();
    rpc.mockResolvedValueOnce({ data: { ...config, secret: 'must-not-leak' }, error: null });
    expect(await getTenantStorageConfig(binding, client)).toEqual(config);
    rpc.mockResolvedValue({ data: null, error: { message: 'secret-provider-detail' } });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('policy_preflight_failed');
    expect(storage.getBucket).not.toHaveBeenCalled();
  });

  it('rejects failed create and failed post-create verification', async () => {
    const { client, storage } = mockClient();
    storage.getBucket.mockResolvedValueOnce({ data: null, error: missing });
    storage.createBucket.mockResolvedValueOnce({ data: null, error: { statusCode: '500' } });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('bucket_creation_failed');
    storage.getBucket.mockResolvedValue({ data: null, error: missing });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('bucket_verification_failed');
  });

  it('rechecks configuration after the API operation and leaves a partial bucket for safe retry', async () => {
    const { client, rpc, storage } = mockClient();
    rpc.mockResolvedValueOnce({ data: config, error: null })
      .mockResolvedValueOnce({ data: { ...config, file_size_limit: 1024 }, error: null });
    storage.getBucket.mockResolvedValueOnce({ data: null, error: missing });
    await expect(ensureTenantStorage(binding, client)).rejects.toThrow('binding_changed');
    expect(await ensureTenantStorage(binding, client)).toEqual({ bucket: bucket.id, created: false });
    expect(storage.createBucket).toHaveBeenCalledTimes(1);
  });

  it('read-only verification never provisions a missing bucket', async () => {
    const { client, storage } = mockClient();
    storage.getBucket.mockResolvedValue({ data: null, error: missing });
    await expect(verifyTenantStorage(binding, client)).rejects.toThrow('bucket_missing');
    expect(storage.createBucket).not.toHaveBeenCalled();
  });

  it('capability discovery fails Storage closed but preserves DB metadata when policy verification fails', async () => {
    const { client, rpc, storage } = mockClient();
    const receipt = { version: 1, requirement_id: binding.requirementId, tenant_id: binding.tenantId,
      schema: binding.schema, identity: { user_id: `${binding.schema}._app_current_user_id`,
        claims: `${binding.schema}._app_request_claims`, backend: `${binding.schema}._app_is_backend_request` },
      storage: { available: true, bucket: binding.bucket }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] } };
    rpc.mockImplementation(async name => name === 'apps_get_tenant_capabilities'
      ? { data: receipt, error: null } : { data: null, error: { code: 'PGRST202' } });
    (client as any).from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: config, error: null }) }) }) });
    (getAppsAdminClient as jest.Mock).mockReturnValue(client);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await getTenantCapabilities(binding.requirementId)).toEqual({ ...receipt, storage: { available: false, bucket: null } });
      expect(storage.createBucket).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});