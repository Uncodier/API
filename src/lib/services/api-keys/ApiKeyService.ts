import crypto from 'crypto';
import { createHash } from 'crypto';
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
   * Genera una nueva API key
   */
  static generateApiKey(prefix: string = 'key'): string {
    const randomBytes = crypto.randomBytes(this.KEY_LENGTH);
    const key = randomBytes.toString('base64url');
    return `${prefix}_${key}`;
  }

  /**
   * Encripta una API key usando AES-256-CBC
   */
  private static encryptApiKey(apiKey: string): string {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    // Create key and IV from the encryption key
    const key = createHash('sha256').update(String(encryptionKey)).digest();
    const iv = createHash('sha256').update(key).digest().subarray(0, 16); // Usar los primeros 16 bytes
    
    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    // Encrypt
    let encrypted = cipher.update(Buffer.from(apiKey, 'utf8'));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Return only the encrypted value in base64
    return encrypted.toString('base64');
  }

  /**
   * Desencripta una API key
   */
  private static decryptApiKey(encryptedKey: string): string {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    try {
      // Create key and IV from the encryption key (same as in encryption)
      const key = createHash('sha256').update(String(encryptionKey)).digest();
      const iv = createHash('sha256').update(key).digest().subarray(0, 16);
      
      // Convert from base64
      const encryptedBuffer = Buffer.from(encryptedKey, 'base64');
      
      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      
      // Decrypt
      let decrypted = decipher.update(encryptedBuffer);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      return decrypted.toString('utf8');
    } catch (error) {
      console.error('Error decrypting key:', error);
      throw new Error("Invalid encrypted key format");
    }
  }

  /**
   * Crea una nueva API key en la base de datos
   */
  static async createApiKey(userId: string, data: ApiKeyData): Promise<{
    apiKey: string;
    id: string;
    prefix: string;
    expires_at: string;
  }> {
    const prefix = data.prefix || 'key';
    const apiKey = this.generateApiKey(prefix);
    const encryptedKey = this.encryptApiKey(apiKey);

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

    const { data: savedKey, error } = await supabaseAdmin
      .from('api_keys')
      .insert(insertData)
      .select('id, prefix, expires_at')
      .single();

    if (error) {
      throw new Error(`Failed to create API key: ${error.message}`);
    }

    return {
      apiKey,
      ...savedKey
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
      const { data: activeKeys, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('status', 'active')
        .eq('prefix', prefix);

      if (error || !activeKeys?.length) {
        return { isValid: false };
      }

      // Intentar encontrar la key correcta
      for (const key of activeKeys) {
        try {
          const decryptedKey = this.decryptApiKey(key.key_hash);
          if (decryptedKey === apiKey) {
            // Verificar expiración
            if (new Date(key.expires_at) < new Date()) {
              // Marcar como expirada
              await supabase
                .from('api_keys')
                .update({ status: 'expired' })
                .eq('id', key.id);
              return { isValid: false };
            }
            
            // Actualizar último uso
            await supabase
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
    const { error } = await supabase
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
    const { data, error } = await supabase
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