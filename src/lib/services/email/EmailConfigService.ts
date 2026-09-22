import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptToken } from '@/lib/utils/token-decryption';
import {
  readRedisJson,
  writeRedisJson,
} from '@/lib/services/redis-json-cache';

export interface EmailConfig {
  user?: string;
  email?: string;
  password: string;
  host?: string;
  imapHost?: string;
  port?: number;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  tls?: boolean;
  aliases?: string[]; // Lista de aliases de email permitidos
  // OAuth2 support
  accessToken?: string;
  useOAuth?: boolean;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export class EmailConfigService {
  /**
   * Obtiene la configuración de email para un sitio
   */
  static async getEmailConfig(siteId: string): Promise<EmailConfig> {
    try {
      const settingsKey = `cache:site-email-settings:${siteId}`;
      let settings = await readRedisJson<any>(settingsKey);
      let settingsError: { message: string } | null = null;
      if (!settings) {
        const result = await supabaseAdmin
          .from('settings')
          .select('channels')
          .eq('site_id', siteId)
          .single();
        settings = result.data;
        settingsError = result.error;
        if (settings) await writeRedisJson(settingsKey, settings, 300);
      }
        
      if (settingsError) {
        throw new Error(`Failed to retrieve site settings: ${settingsError.message}`);
      }
      
      if (!settings) {
        throw new Error(`Site settings not found for site ${siteId}`);
      }

      // Obtener el token de email
      const tokenValue = await this.getEmailToken(
        siteId,
        settings.channels?.email?.email,
      );
      
      if (!tokenValue) {
        throw new Error(`No se encontró token de email para el sitio ${siteId}. Por favor almacena un token de email usando el endpoint /api/secure-tokens`);
      }

      // Obtener aliases de la configuración del canal de email
      const aliases = settings.channels?.email?.aliases || null;

      try {
        // Intentar parsear como JSON
        const parsedValue = JSON.parse(tokenValue);
        
        if (parsedValue.password) {
          return {
            user: parsedValue.email || parsedValue.user || settings.channels?.email?.email,
            email: parsedValue.email || parsedValue.user || settings.channels?.email?.email,
            password: parsedValue.password,
            host: parsedValue.host || parsedValue.imapHost || settings.channels?.email?.incomingServer || 'imap.gmail.com',
            imapHost: parsedValue.imapHost || parsedValue.host || settings.channels?.email?.incomingServer || 'imap.gmail.com',
            imapPort: parsedValue.imapPort || parsedValue.port || settings.channels?.email?.incomingPort || 993,
            smtpHost: parsedValue.smtpHost || parsedValue.host || settings.channels?.email?.outgoingServer || 'smtp.gmail.com',
            smtpPort: parsedValue.smtpPort || settings.channels?.email?.outgoingPort || 587,
            tls: true,
            aliases: aliases
          };
        }
      } catch (jsonError) {
        // Si no es JSON, usar como contraseña directa
        return {
          user: settings.channels?.email?.email,
          email: settings.channels?.email?.email,
          password: tokenValue,
          host: settings.channels?.email?.incomingServer || 'imap.gmail.com',
          imapHost: settings.channels?.email?.incomingServer || 'imap.gmail.com',
          imapPort: settings.channels?.email?.incomingPort || 993,
          smtpHost: settings.channels?.email?.outgoingServer || 'smtp.gmail.com',
          smtpPort: settings.channels?.email?.outgoingPort || 587,
          tls: true,
          aliases: aliases
        };
      }
      
      throw new Error("El token de email no contiene una contraseña");
    } catch (error) {
      throw error;
    }
  }

  /**
   * Obtiene y desencripta el token de email
   */
  private static async getEmailToken(
    siteId: string,
    email?: string,
  ): Promise<string | null> {
    try {
      const cacheKey = `cache:email-token-encrypted:${siteId}`;
      const cached = await readRedisJson<{ encryptedValue: string }>(cacheKey);
      if (cached?.encryptedValue) return this.decryptToken(cached.encryptedValue);
      
      // Consulta base para el token
      const baseTokenQuery = () => supabaseAdmin
        .from('secure_tokens')
        .select('*')
        .eq('site_id', siteId)
        .eq('token_type', 'email');
      
      // Si tenemos email, primero intentar con identifier
      if (email) {
        const { data: withIdentifier } = await baseTokenQuery()
          .eq('identifier', email)
          .maybeSingle();
        if (withIdentifier?.encrypted_value) {
          await writeRedisJson(
            cacheKey,
            { encryptedValue: withIdentifier.encrypted_value },
            60,
          );
          console.log(`[EmailConfigService] ✅ Token encontrado con identifier, desencriptando localmente...`);
          const decryptedToken = this.decryptToken(withIdentifier.encrypted_value);
          if (decryptedToken) {
            return decryptedToken;
          }
          console.log(`[EmailConfigService] ⚠️ Desencriptación local falló, intentando sin identifier...`);
        }
      }

      // Si no se encontró con identifier o no hay email, intentar sin identifier
      const { data: withoutIdentifier } = await baseTokenQuery()
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (withoutIdentifier?.encrypted_value) {
        await writeRedisJson(
          cacheKey,
          { encryptedValue: withoutIdentifier.encrypted_value },
          60,
        );
        console.log(`[EmailConfigService] ✅ Token encontrado sin identifier, desencriptando localmente...`);
        const decryptedToken = this.decryptToken(withoutIdentifier.encrypted_value);
        if (decryptedToken) {
          return decryptedToken;
        }
        console.log(`[EmailConfigService] ⚠️ Desencriptación local falló`);
      }

      console.log(`[EmailConfigService] ❌ No se pudo obtener token de ninguna fuente`);
      return null;
    } catch (error) {
      console.error(`[EmailConfigService] ❌ Error obteniendo token:`, error);
      return null;
    }
  }

  /**
   * Desencripta un token usando la utilidad compartida de desencriptación
   */
  private static decryptToken(encryptedValue: string): string | null {
    return decryptToken(encryptedValue);
  }
} 