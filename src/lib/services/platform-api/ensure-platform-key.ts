import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { defaultTestOnlyScopesForRequirement } from './scopes-catalog';

export interface EnsurePlatformKeyInput {
  requirement_id: string;
  site_id: string;
  user_id: string;
  /** `remote_instances.id` to persist the key id back onto. */
  instance_id?: string | null;
  /** Optional override when a specific requirement needs fewer scopes. */
  scopes?: string[];
  /** Force rotation. Revokes the previous key and mints a new one. */
  rotate?: boolean;
}

export interface EnsurePlatformKeyResult {
  api_key: string;
  key_id: string;
  created: boolean;
  expires_at: string;
  scopes: string[];
}

/**
 * Ensures the requirement has a test-only Platform API key. When `rotate` is
 * true or no active key is recorded in `remote_instances.metadata.platform_key_id`,
 * a new key is minted via `ApiKeyService.createApiKey`. The raw key is
 * returned ONCE (to be injected into the sandbox env) — we only persist the
 * id on the remote_instance.
 */
export async function ensurePlatformKeyForRequirement(
  params: EnsurePlatformKeyInput,
): Promise<EnsurePlatformKeyResult> {
  const { requirement_id, site_id, user_id, instance_id, rotate } = params;
  const scopes = params.scopes?.length ? params.scopes : defaultTestOnlyScopesForRequirement();

  let priorKeyId: string | null = null;
  if (instance_id) {
    const { data: instance } = await supabaseAdmin
      .from('remote_instances')
      .select('metadata')
      .eq('id', instance_id)
      .maybeSingle();
    const meta = (instance?.metadata ?? {}) as Record<string, any>;
    priorKeyId = (meta.platform_key_id as string | undefined) ?? null;
  }

  if (priorKeyId && !rotate) {
    const { data: existing } = await supabaseAdmin
      .from('api_keys')
      .select('id, status, expires_at, scopes')
      .eq('id', priorKeyId)
      .maybeSingle();
    if (existing && existing.status === 'active' && new Date(existing.expires_at) > new Date()) {
      return {
        api_key: '',
        key_id: existing.id,
        created: false,
        expires_at: existing.expires_at,
        scopes: (existing.scopes as string[]) ?? scopes,
      };
    }
  }

  if (priorKeyId && rotate) {
    // Revoke first so an in-flight request with the old token still fails fast,
    // then hard-delete the row so we do not accumulate hundreds of stale
    // Platform keys for long-lived requirements. The delete is scoped to
    // `metadata.issued_by = 'platform-api.ensure-platform-key'` so it can
    // never remove a user-managed key by mistake.
    await ApiKeyService.revokeApiKey(user_id, priorKeyId, site_id).catch(() => undefined);
    await supabaseAdmin
      .from('api_keys')
      .delete()
      .eq('id', priorKeyId)
      .eq('user_id', user_id)
      .eq('site_id', site_id)
      .contains('metadata', { issued_by: 'platform-api.ensure-platform-key' })
      .then(({ error }) => {
        if (error) {
          console.warn('[ensure-platform-key] prior key cleanup failed (continuing):', error.message);
        }
      });
  }

  const created = await ApiKeyService.createApiKey(user_id, {
    name: `platform-${requirement_id.slice(0, 8)}`,
    scopes,
    site_id,
    expirationDays: 60,
    prefix: 'upk',
    metadata: {
      requirement_id,
      posture: 'test-only',
      issued_by: 'platform-api.ensure-platform-key',
      issued_at: new Date().toISOString(),
    },
  });

  if (instance_id) {
    const { data: inst } = await supabaseAdmin
      .from('remote_instances')
      .select('metadata')
      .eq('id', instance_id)
      .maybeSingle();
    const meta = (inst?.metadata ?? {}) as Record<string, any>;
    meta.platform_key_id = created.id;
    await supabaseAdmin.from('remote_instances').update({ metadata: meta }).eq('id', instance_id);
  }

  return {
    api_key: created.apiKey,
    key_id: created.id,
    created: true,
    expires_at: created.expires_at,
    scopes,
  };
}
