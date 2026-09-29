import { createHash } from 'node:crypto';
import { encryptApiKey } from '@/lib/services/api-keys/api-key-crypto';
import { ids } from './fixtures';

export const credentialKey = 'key_realtime-original-secret';
export const credentialVersion = '10000000-0000-4000-8000-000000000008';

export async function credentialRow(key = credentialKey) {
  return {
    id: 'key-1', user_id: 'user-1', site_id: ids.site as string | null, prefix: 'key',
    lookup_hash: createHash('sha256').update(key).digest('hex') as string | null,
    key_hash: await encryptApiKey(key), scopes: ['read'], status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(), identity_token_version: credentialVersion,
  };
}

export function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}