import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

/** Platform-only binding. Never accept these values directly from an app tool. */
export interface TenantStorageBinding {
  requirementId: string;
  tenantId: string;
  schema: string;
  bucket: string;
  userId?: string;
  siteId?: string;
}

export interface TenantStorageConfig {
  version: 1;
  policy_version: 1;
  requirement_id: string;
  tenant_id: string;
  schema: string;
  bucket: string;
  user_id: string;
  site_id: string;
  status: 'active';
  file_size_limit: number;
  allowed_mime_types: string[];
}

export class TenantStorageError extends Error {
  constructor(public readonly code: string) {
    super(`Tenant Storage unavailable (${code}). Platform provisioning must repair this capability.`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'TenantStorageError';
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** The service-role-only RPC also verifies the installed platform policies. */
export async function getTenantStorageConfig(
  binding: TenantStorageBinding,
  client: SupabaseClient = getAppsAdminClient(),
): Promise<TenantStorageConfig> {
  if (!uuid.test(binding.requirementId) || !uuid.test(binding.tenantId) ||
      !/^app_[a-f0-9]{24}$/.test(binding.schema) ||
      binding.bucket !== `tenant-${binding.schema.slice(4)}`) {
    throw new TenantStorageError('invalid_binding');
  }
  const { data, error } = await client.rpc('apps_get_tenant_storage_config', {
    p_requirement_id: binding.requirementId,
    p_expected_tenant_id: binding.tenantId,
  });
  if (error) throw new TenantStorageError('policy_preflight_failed');
  const v = data as Partial<TenantStorageConfig> | null;
  if (!v || v.version !== 1 || v.policy_version !== 1 || v.status !== 'active' ||
      v.requirement_id !== binding.requirementId || v.tenant_id !== binding.tenantId ||
      v.schema !== binding.schema || v.bucket !== binding.bucket ||
      typeof v.user_id !== 'string' || !uuid.test(v.user_id) ||
      typeof v.site_id !== 'string' || !uuid.test(v.site_id) ||
      (binding.userId !== undefined && v.user_id !== binding.userId) ||
      (binding.siteId !== undefined && v.site_id !== binding.siteId) ||
      !Number.isSafeInteger(v.file_size_limit) || v.file_size_limit! <= 0 ||
      v.file_size_limit! > 10 * 1024 * 1024 ||
      !Array.isArray(v.allowed_mime_types) || !v.allowed_mime_types.length ||
      v.allowed_mime_types.some(type => typeof type !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type))) {
    throw new TenantStorageError('invalid_config');
  }
  // Explicit allowlist: never return arbitrary RPC fields or credentials.
  return {
    version: 1, policy_version: 1, status: 'active',
    requirement_id: v.requirement_id, tenant_id: v.tenant_id,
    schema: v.schema, bucket: v.bucket, user_id: v.user_id, site_id: v.site_id,
    file_size_limit: v.file_size_limit!, allowed_mime_types: [...v.allowed_mime_types],
  };
}

function storageErrorIs(error: unknown, kind: 'missing' | 'conflict'): boolean {
  const e = error as { statusCode?: string | number; code?: string; message?: string } | null;
  if (!e) return false;
  const code = String(e.code ?? e.statusCode ?? '');
  // Do not mistake a proxy HTTP 404, permission error, or outage for a missing bucket.
  return kind === 'missing'
    ? code === 'NoSuchBucket' || (code === '404' && e.message === 'Bucket not found')
    : code === 'BucketAlreadyExists' || code === 'ResourceAlreadyExists' ||
      (code === '409' && /^(The resource already exists|Bucket already exists)$/.test(e.message ?? ''));
}

function verifyBucket(bucket: unknown, config: TenantStorageConfig): void {
  const v = bucket as { id?: string; name?: string; public?: boolean;
    file_size_limit?: number | null; allowed_mime_types?: string[] | null } | null;
  if (!v || v.id !== config.bucket || v.name !== config.bucket || v.public !== false ||
      !Number.isSafeInteger(v.file_size_limit) || v.file_size_limit! <= 0 ||
      v.file_size_limit! > config.file_size_limit ||
      !Array.isArray(v.allowed_mime_types) || !v.allowed_mime_types.length ||
      v.allowed_mime_types.some(type => !config.allowed_mime_types.includes(type))) {
    // Preserve existing objects/configuration. Never silently widen an existing bucket.
    throw new TenantStorageError('bucket_configuration_mismatch');
  }
}

/** Read-only verification: discovery must never create or repair infrastructure. */
export async function verifyTenantStorage(
  binding: TenantStorageBinding,
  client: SupabaseClient = getAppsAdminClient(),
): Promise<void> {
  const config = await getTenantStorageConfig(binding, client);
  const { data, error } = await client.storage.getBucket(config.bucket);
  if (error) throw new TenantStorageError(storageErrorIs(error, 'missing') ? 'bucket_missing' : 'bucket_lookup_failed');
  verifyBucket(data, config);
}

/** Retryable saga: SQL policy preflight -> Storage API -> recheck binding/policies.
 * No global SQL, membership writes, bucket deletion, or arbitrary policy input.
 */
export async function ensureTenantStorage(
  binding: TenantStorageBinding,
  client: SupabaseClient = getAppsAdminClient(),
): Promise<{ bucket: string; created: boolean }> {
  const config = await getTenantStorageConfig(binding, client);
  let bucket = await client.storage.getBucket(config.bucket);
  let created = false;
  if (bucket.error) {
    if (!storageErrorIs(bucket.error, 'missing')) throw new TenantStorageError('bucket_lookup_failed');
    const result = await client.storage.createBucket(config.bucket, {
      public: false,
      fileSizeLimit: config.file_size_limit,
      allowedMimeTypes: config.allowed_mime_types,
    });
    if (result.error && !storageErrorIs(result.error, 'conflict')) {
      throw new TenantStorageError('bucket_creation_failed');
    }
    created = !result.error;
    bucket = await client.storage.getBucket(config.bucket);
  }
  if (bucket.error) throw new TenantStorageError('bucket_verification_failed');
  verifyBucket(bucket.data, config);
  const fresh = await getTenantStorageConfig(binding, client);
  if (JSON.stringify(fresh) !== JSON.stringify(config)) throw new TenantStorageError('binding_changed');
  return { bucket: config.bucket, created };
}