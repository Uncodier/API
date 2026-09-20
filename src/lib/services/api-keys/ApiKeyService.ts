import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  deleteKey,
  getCachedJson,
  setCachedJson,
  sha256,
} from '@/lib/security/upstash-rest';
import {
  decryptApiKey as decryptStoredApiKey,
  encryptApiKey as encryptStoredApiKey,
  generateApiKey as generateRandomApiKey,
} from './api-key-crypto';

export interface ApiKeyData {
  name: string;
  scopes: string[];
  site_id?: string | null;
  expirationDays?: number;
  prefix?: string;
  metadata?: Record<string, unknown>;
}

interface StoredApiKey {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  user_id: string;
  site_id: string | null;
  scopes: string[];
  expires_at: string;
  metadata: Record<string, unknown>;
  status: string;
}

export class ApiKeyService {
  private static readonly PREFIX_LENGTH = 8;

  static generateApiKey(prefix = 'key'): string {
    return generateRandomApiKey(prefix);
  }

  private static async encryptApiKey(apiKey: string): Promise<string> {
    return encryptStoredApiKey(apiKey);
  }

  private static async decryptApiKey(encryptedKey: string): Promise<string> {
    return decryptStoredApiKey(encryptedKey);
  }

  static async createApiKey(
    userId: string,
    data: ApiKeyData,
    options?: { client?: any },
  ): Promise<{
    apiKey: string;
    id: string;
    prefix: string;
    expires_at: string;
  }> {
    const prefix = data.prefix || 'key';
    const apiKey = this.generateApiKey(prefix);
    const encryptedKey = await this.encryptApiKey(apiKey);
    const lookupHash = await sha256(apiKey);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (data.expirationDays || 90));
    const insertData = {
      name: data.name,
      key_hash: encryptedKey,
      lookup_hash: lookupHash,
      prefix,
      user_id: userId,
      site_id: data.site_id,
      scopes: data.scopes,
      expires_at: expiresAt.toISOString(),
      metadata: data.metadata || {},
      status: 'active',
    };

    const dbClient = options?.client || supabaseAdmin;
    const { data: inserted, error } = await dbClient
      .from('api_keys')
      .insert(insertData)
      .select('id, prefix, expires_at')
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to create API key: ${error.message}`);
    }

    // A user-scoped insert can succeed while SELECT RLS hides its representation.
    // Re-read with the admin client instead of retrying the insert.
    let row = inserted;
    if (!row) {
      const { data: adminRow, error: fetchError } = await supabaseAdmin
        .from('api_keys')
        .select('id, prefix, expires_at')
        .eq('lookup_hash', lookupHash)
        .maybeSingle();
      if (fetchError || !adminRow) {
        throw new Error(
          `Failed to read created API key: ${fetchError?.message || 'row not returned'}`,
        );
      }
      row = adminRow;
    }

    return {
      apiKey,
      id: row.id,
      prefix: row.prefix,
      expires_at: row.expires_at,
    };
  }

  static async validateApiKey(apiKey: string): Promise<{
    isValid: boolean;
    keyData?: Omit<StoredApiKey, 'key_hash'>;
  }> {
    try {
      const [prefix] = apiKey.split('_');
      if (!prefix || prefix.length > this.PREFIX_LENGTH) {
        return { isValid: false };
      }

      const apiKeyHash = await sha256(apiKey);
      const cacheKey = `auth:api-key:${apiKeyHash}`;
      const cached = await getCachedJson<{
        isValid: boolean;
        keyData?: Omit<StoredApiKey, 'key_hash'>;
      }>(cacheKey);
      if (cached) return cached;

      const columns =
        'id, name, key_hash, prefix, user_id, site_id, scopes, expires_at, metadata, status';
      const { data: hashedKeys, error: hashError } = await supabaseAdmin
        .from('api_keys')
        .select(columns)
        .eq('status', 'active')
        .eq('lookup_hash', apiKeyHash);
      const legacyLookup = !hashedKeys?.length
        ? await supabaseAdmin
          .from('api_keys')
          .select(columns)
          .eq('status', 'active')
          .eq('prefix', prefix)
          .is('lookup_hash', null)
          .limit(25)
        : { data: null, error: null };
      const activeKeys = (
        hashedKeys?.length ? hashedKeys : legacyLookup.data
      ) as StoredApiKey[] | null;

      if (hashError || legacyLookup.error || !activeKeys?.length) {
        await setCachedJson(cacheKey, { isValid: false }, 10);
        return { isValid: false };
      }

      for (const key of activeKeys) {
        let decrypted: string;
        try {
          decrypted = await this.decryptApiKey(key.key_hash);
        } catch {
          continue;
        }
        if (await sha256(decrypted) !== apiKeyHash) continue;

        if (new Date(key.expires_at).getTime() <= Date.now()) {
          await supabaseAdmin
            .from('api_keys')
            .update({ status: 'expired' })
            .eq('id', key.id);
          await setCachedJson(cacheKey, { isValid: false }, 10);
          return { isValid: false };
        }

        await supabaseAdmin
          .from('api_keys')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', key.id);
        const { key_hash: _encryptedMaterial, ...keyData } = key;
        const result = { isValid: true, keyData };
        await setCachedJson(cacheKey, result, 60);
        return result;
      }

      await setCachedJson(cacheKey, { isValid: false }, 10);
      return { isValid: false };
    } catch (error) {
      console.error('[ApiKeyService] Validation failed:', error);
      return { isValid: false };
    }
  }

  static async revokeApiKey(
    userId: string,
    keyId: string,
    siteId: string,
  ): Promise<boolean> {
    const { data: existing } = await supabaseAdmin
      .from('api_keys')
      .select('lookup_hash, key_hash')
      .eq('id', keyId)
      .eq('user_id', userId)
      .eq('site_id', siteId)
      .maybeSingle();
    const { error } = await supabaseAdmin
      .from('api_keys')
      .update({ status: 'revoked' })
      .eq('id', keyId)
      .eq('user_id', userId)
      .eq('site_id', siteId);
    if (!error && existing) {
      let lookupHash = existing.lookup_hash;
      if (!lookupHash && existing.key_hash) {
        try {
          lookupHash = await sha256(await this.decryptApiKey(existing.key_hash));
        } catch {
          lookupHash = null;
        }
      }
      if (lookupHash) await deleteKey(`auth:api-key:${lookupHash}`);
    }
    return !error;
  }

  static async listApiKeys(userId: string, siteId: string) {
    const { data, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, name, prefix, status, scopes, last_used_at, expires_at, created_at')
      .eq('user_id', userId)
      .eq('site_id', siteId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Failed to list API keys: ${error.message}`);
    return data;
  }
}
