import { supabase, supabaseAdmin } from '@/lib/database/supabase-client';

export interface ApiKeyData {
  name: string;
  scopes: string[];
  site_id: string;
  expirationDays?: number;
  prefix?: string;
  metadata?: Record<string, any>;
}

export class ApiKeyService {
  private static readonly KEY_LENGTH = 32;
  private static readonly PREFIX_LENGTH = 8;
  
  /**
   * Genera una nueva API key usando Web Crypto API
   */
  static generateApiKey(prefix: string = 'key'): string {
    // Usar Web Crypto API para generar bytes aleatorios
    const array = new Uint8Array(this.KEY_LENGTH);
    crypto.getRandomValues(array);
    
    // Convertir a base64url
    const key = btoa(String.fromCharCode(...Array.from(array)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    return `${prefix}_${key}`;
  }

  /**
   * Deriva una clave de encriptación usando Web Crypto API
   */
  private static async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encripta una API key usando Web Crypto API (AES-GCM)
   */
  private static async encryptApiKey(apiKey: string): Promise<string> {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }

    // Check if Web Crypto API is available
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error("Web Crypto API is not available in this environment");
    }
    
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(apiKey);
      
      // Generar salt aleatorio
      const salt = crypto.getRandomValues(new Uint8Array(16));
      
      // Generar IV aleatorio
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      // Derivar clave
      const key = await this.deriveKey(encryptionKey, salt);
      
      // Encriptar
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        data
      );
      
      // Combinar salt + iv + datos encriptados
      const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
      result.set(salt, 0);
      result.set(iv, salt.length);
      result.set(new Uint8Array(encrypted), salt.length + iv.length);
      
      // Convertir a base64
      return btoa(String.fromCharCode(...Array.from(result)));
    } catch (error) {
      console.error('[ApiKeyService] Error encrypting:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        cryptoAvailable: typeof crypto !== 'undefined',
        cryptoSubtleAvailable: typeof crypto !== 'undefined' && !!crypto.subtle
      });
      throw new Error(`Failed to encrypt API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Desencripta una API key. Intenta Web Crypto API primero, luego fallback a Node.js crypto
   */
  private static async decryptApiKey(encryptedKey: string): Promise<string> {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    // Intentar con el nuevo formato (AES-GCM) primero para keys nuevas
    try {
      const data = new Uint8Array(
        atob(encryptedKey).split('').map(char => char.charCodeAt(0))
      );
      
      // Verificar si tiene el tamaño correcto para el nuevo formato (salt + iv + data)
      if (data.length >= 28) {
        const salt = data.slice(0, 16);
        const iv = data.slice(16, 28);
        const encrypted = data.slice(28);
        
        const key = await this.deriveKey(encryptionKey, salt);
        
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv },
          key,
          encrypted
        );
        
        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
      }
    } catch (error) {
      console.log('[ApiKeyService] New format failed, trying legacy format');
    }
    
    // Fallback para keys existentes (AES-256-CBC) usando Web Crypto API
    try {
      const encoder = new TextEncoder();
      
      // Crear hash SHA-256 de la clave de encriptación usando Web Crypto API
      const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(encryptionKey));
      const keyArray = new Uint8Array(keyData);
      
      // Crear IV derivado usando SHA-256 del key
      const ivData = await crypto.subtle.digest('SHA-256', keyArray);
      const iv = new Uint8Array(ivData).slice(0, 16);
      
      // Importar la clave para AES-CBC
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyArray,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );
      
      // Decodificar de base64
      const encryptedData = new Uint8Array(
        atob(encryptedKey).split('').map(char => char.charCodeAt(0))
      );
      
      // Desencriptar
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: iv },
        cryptoKey,
        encryptedData
      );
      
      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('[ApiKeyService] Both decryption methods failed:', error);
      throw new Error("Invalid encrypted key format");
    }
  }

  /**
   * Crea una nueva API key en la base de datos
   */
  static async createApiKey(
    userId: string,
    data: ApiKeyData,
    options?: { client?: any }
  ): Promise<{
    apiKey: string;
    id: string;
    prefix: string;
    expires_at: string;
  }> {
    const prefix = data.prefix || 'key';
    const apiKey = this.generateApiKey(prefix);
    const encryptedKey = await this.encryptApiKey(apiKey);

    // Calcular fecha de expiración
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (data.expirationDays || 90));

    const insertData = {
      name: data.name,
      key_hash: encryptedKey,
      prefix,
      user_id: userId,
      site_id: data.site_id,
      scopes: data.scopes,
      expires_at: expiresAt.toISOString(),
      metadata: data.metadata || {},
      status: 'active'
    };

    console.log('[ApiKeyService] Insert payload sanity check:', {
      hasName: !!insertData.name,
      prefix: insertData.prefix,
      user_id: insertData.user_id,
      site_id: insertData.site_id,
      scopes_len: Array.isArray(insertData.scopes) ? insertData.scopes.length : 0,
      expires_after_now: new Date(insertData.expires_at) > new Date(),
      metadata_keys: Object.keys(insertData.metadata || {}).length
    });

    // Try insert requesting representation explicitly to avoid empty body
    const dbClient = options?.client || supabaseAdmin;

    const { data: insertedRows, error } = await dbClient
      .from('api_keys')
      .insert(insertData)
      .select('id, prefix, expires_at, user_id, site_id, created_at');

    // If user-scoped client returns empty due to SELECT RLS, try admin reselect
    if (!error && (!insertedRows || insertedRows.length === 0)) {
      console.log('[ApiKeyService] No rows returned under user client, trying admin insert fallback');
      const { data: adminInsertRows, error: adminInsertError } = await supabaseAdmin
        .from('api_keys')
        .insert(insertData)
        .select('id, prefix, expires_at, user_id, site_id, created_at');

      if (adminInsertError) {
        console.error('[ApiKeyService] Admin insert error:', {
          error: adminInsertError.message,
          code: adminInsertError.code
        });
      }

      if (adminInsertRows && adminInsertRows.length > 0) {
        return {
          apiKey,
          id: adminInsertRows[0].id,
          prefix: adminInsertRows[0].prefix,
          expires_at: adminInsertRows[0].expires_at
        };
      }

      const { data: adminInserted } = await supabaseAdmin
        .from('api_keys')
        .select('id, prefix, expires_at, user_id, site_id, created_at')
        .eq('key_hash', encryptedKey)
        .order('created_at', { ascending: false })
        .limit(1);
      if (adminInserted && adminInserted.length > 0) {
        return {
          apiKey,
          id: adminInserted[0].id,
          prefix: adminInserted[0].prefix,
          expires_at: adminInserted[0].expires_at
        };
      }
    }

    if (error) {
      console.error('[ApiKeyService] Database insert error:', {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      throw new Error(`Failed to create API key: ${error.message}`);
    }

    console.log('[ApiKeyService] Insert result rows length:', insertedRows?.length || 0);

    // Some PostgREST setups can still return 0 rows on insert + select due to RLS select policy.
    // Fallback: fetch the just-inserted row by its unique key_hash.
    let resultRow = insertedRows && insertedRows[0] ? insertedRows[0] : undefined;
    if (!resultRow) {
      // First attempt: fetch by key_hash
      const { data: fetchedByHash, error: fetchByHashError } = await dbClient
        .from('api_keys')
        .select('id, prefix, expires_at, created_at')
        .eq('key_hash', encryptedKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchedByHash) {
        resultRow = fetchedByHash;
      } else {
        // Second attempt: fetch the most recent row for this user/site/name
        const { data: fetchedRecent, error: fetchRecentError } = await dbClient
          .from('api_keys')
          .select('id, prefix, expires_at, created_at')
          .eq('user_id', userId)
          .eq('site_id', data.site_id)
          .eq('name', data.name)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (fetchedRecent) {
          resultRow = fetchedRecent;
        } else {
          const err = fetchByHashError || fetchRecentError;
          console.error('[ApiKeyService] Post-insert fetch failed:', {
            error: err?.message,
            code: err?.code,
            details: err?.details,
            hint: err?.hint
          });
          // As a final attempt, use admin client to bypass any RLS/select issues
          const { data: fetchedAdmin, error: adminFetchError } = await supabaseAdmin
            .from('api_keys')
            .select('id, prefix, expires_at, created_at')
            .eq('key_hash', encryptedKey)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (fetchedAdmin) {
            resultRow = fetchedAdmin;
          } else {
            console.error('[ApiKeyService] Admin fetch also failed:', {
              error: adminFetchError?.message,
              code: adminFetchError?.code
            });
            throw new Error('Failed to create API key: no row returned by PostgREST after insert');
          }
        }
      }
    }

    return {
      apiKey,
      ...resultRow
    };
  }

  /**
   * Valida una API key
   */
  static async validateApiKey(apiKey: string): Promise<{
    isValid: boolean;
    keyData?: any;
  }> {
    try {
      // Validar formato
      const [prefix] = apiKey.split('_');
      if (!prefix || prefix.length > this.PREFIX_LENGTH) {
        return { isValid: false };
      }

      // Buscar todas las keys activas con ese prefijo
      const { data: activeKeys, error } = await supabaseAdmin
        .from('api_keys')
        .select('*')
        .eq('status', 'active')
        .eq('prefix', prefix);

      if (error || !activeKeys?.length) {
        console.log('[ApiKeyService] No active keys found:', {
          error: error?.message,
          keysFound: activeKeys?.length || 0,
          prefix
        });
        return { isValid: false };
      }

      console.log('[ApiKeyService] Found active keys:', activeKeys.length);

      // Intentar encontrar la key correcta
      for (const key of activeKeys) {
        try {
          const decryptedKey = await this.decryptApiKey(key.key_hash);
          console.log('[ApiKeyService] Comparing keys:', {
            keyId: key.id,
            inputKeyLength: apiKey.length,
            decryptedKeyLength: decryptedKey.length,
            match: decryptedKey === apiKey,
            // Solo mostrar los primeros caracteres para seguridad
            inputPrefix: apiKey.substring(0, 10) + '...',
            decryptedPrefix: decryptedKey.substring(0, 10) + '...'
          });
          
          if (decryptedKey === apiKey) {
            // Verificar expiración
            if (new Date(key.expires_at) < new Date()) {
              console.log('[ApiKeyService] Key expired:', key.id);
              // Marcar como expirada
              await supabaseAdmin
                .from('api_keys')
                .update({ status: 'expired' })
                .eq('id', key.id);
              return { isValid: false };
            }
            
            console.log('[ApiKeyService] Valid key found:', key.id);
            // Actualizar último uso
            await supabaseAdmin
              .from('api_keys')
              .update({ last_used_at: new Date().toISOString() })
              .eq('id', key.id);

            return { 
              isValid: true,
              keyData: key
            };
          }
        } catch (decryptError) {
          console.error('Error decrypting key:', decryptError);
          continue;
        }
      }

      return { isValid: false };
    } catch (error) {
      console.error('Error validating API key:', error);
      return { isValid: false };
    }
  }

  /**
   * Revoca una API key
   */
  static async revokeApiKey(userId: string, keyId: string, siteId: string): Promise<boolean> {
    const { error } = await supabaseAdmin
      .from('api_keys')
      .update({ status: 'revoked' })
      .eq('id', keyId)
      .eq('user_id', userId)
      .eq('site_id', siteId);

    return !error;
  }

  /**
   * Lista las API keys de un usuario para un sitio específico
   */
  static async listApiKeys(userId: string, siteId: string) {
    const { data, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, name, prefix, status, scopes, last_used_at, expires_at, created_at')
      .eq('user_id', userId)
      .eq('site_id', siteId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list API keys: ${error.message}`);
    }

    return data;
  }
} 