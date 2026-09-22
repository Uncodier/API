/**
 * Servicio para validar peticiones de Twilio usando su signature validation
 */

import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptToken } from '@/lib/utils/token-decryption';
import { pickMatchingWhatsAppToken } from '@/lib/services/twilio/whatsapp-number-match';
import { getCachedJson, setCachedJson, sha256 } from '@/lib/security/upstash-rest';

interface TwilioValidationResult {
  isValid: boolean;
  error?: string;
  authToken?: string;
}

export class TwilioValidationService {
  /**
   * Valida una petición de Twilio usando la firma X-Twilio-Signature
   */
  static async validateTwilioRequest(
    url: string,
    postData: Record<string, any>,
    twilioSignature: string,
    whatsappNumber: string,
    siteId: string
  ): Promise<TwilioValidationResult> {
    try {
      console.log('[TwilioValidation] Iniciando validación de Twilio');
      console.log('[TwilioValidation] URL:', url);
      console.log('[TwilioValidation] WhatsApp Number:', whatsappNumber);
      console.log('[TwilioValidation] Site ID:', siteId);
      console.log('[TwilioValidation] Signature present:', !!twilioSignature);

      // Buscar el auth token en secure_tokens
      const authTokenResult = await this.getAuthTokenFromSecureTokens(whatsappNumber, siteId);
      
      if (!authTokenResult.success) {
        console.error('[TwilioValidation] Error al obtener auth token:', authTokenResult.error);
        return {
          isValid: false,
          error: authTokenResult.error
        };
      }

      const authToken = authTokenResult.authToken!;
      console.log('[TwilioValidation] Auth token obtenido exitosamente');

      // Validar la firma usando el algoritmo de Twilio
      const isValid = this.validateSignature(url, postData, twilioSignature, authToken);
      
      console.log('[TwilioValidation] Resultado de validación:', isValid);
      
      return {
        isValid,
        authToken,
        error: isValid ? undefined : 'Invalid Twilio signature'
      };

    } catch (error) {
      console.error('[TwilioValidation] Error en validación:', error);
      return {
        isValid: false,
        error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Busca el auth token en secure_tokens usando el número de WhatsApp como identifier
   */
  private static async getAuthTokenFromSecureTokens(
    whatsappNumber: string, 
    siteId: string
  ): Promise<{ success: boolean; authToken?: string; error?: string }> {
    try {
      console.log('[TwilioValidation] Buscando auth token para número:', whatsappNumber);
      const cacheKey = `twilio:auth-token:${await sha256(
        `${siteId}:${whatsappNumber}`,
      )}`;
      const cached = await getCachedJson<{
        encryptedValue?: string;
        missing?: boolean;
      }>(cacheKey);
      if (cached?.missing) {
        return { success: false, error: 'No Twilio auth token found' };
      }
      if (cached?.encryptedValue) {
        const authToken = this.decryptToken(cached.encryptedValue);
        return authToken
          ? { success: true, authToken }
          : { success: false, error: 'Failed to decrypt auth token' };
      }
      
      // Site already resolved. Match identifier with MX +52/+521 variants;
      // if the site has a single WhatsApp token, use it even when formats differ.
      const { data: tokens, error } = await supabaseAdmin
        .from('secure_tokens')
        .select('identifier, encrypted_value, value')
        .eq('site_id', siteId)
        .eq('token_type', 'twilio_whatsapp');

      if (error) {
        console.error('[TwilioValidation] Error en consulta a base de datos:', error);
        return {
          success: false,
          error: `Database error: ${error.message}`
        };
      }

      const tokenRecord = pickMatchingWhatsAppToken(tokens || [], whatsappNumber);
      if (!tokenRecord) {
        await setCachedJson(cacheKey, { missing: true }, 30);
        console.log('[TwilioValidation] No se encontró token para este número');
        return {
          success: false,
          error: `No Twilio auth token found for WhatsApp number ${whatsappNumber} in site ${siteId}`
        };
      }
      console.log('[TwilioValidation] Token encontrado, desencriptando...');

      // Desencriptar el token
      const encryptedValue = tokenRecord.encrypted_value || tokenRecord.value;
      const decryptedToken = this.decryptToken(encryptedValue);
      
      if (!decryptedToken) {
        return {
          success: false,
          error: 'Failed to decrypt auth token'
        };
      }

      await setCachedJson(cacheKey, { encryptedValue }, 300);
      console.log('[TwilioValidation] Token desencriptado exitosamente');
      return {
        success: true,
        authToken: decryptedToken
      };

    } catch (error) {
      console.error('[TwilioValidation] Error al buscar auth token:', error);
      return {
        success: false,
        error: `Error retrieving auth token: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Valida la firma de Twilio usando su algoritmo oficial
   * Implementación basada en la documentación de Twilio:
   * https://www.twilio.com/docs/usage/webhooks/webhooks-security
   */
  static validateSignature(
    url: string,
    postData: Record<string, string | string[]>,
    twilioSignature: string,
    authToken: string
  ): boolean {
    try {
      // 1. Crear la cadena de datos ordenados
      let dataString = url;
      
      // Ordenar las claves alfabéticamente y concatenar
      const sortedKeys = Object.keys(postData).sort();
      for (const key of sortedKeys) {
        const value = postData[key];
        const values = Array.isArray(value)
          ? Array.from(new Set(value)).sort()
          : [value];
        for (const value of values) {
          dataString += key + value;
        }
      }

      console.log('[TwilioValidation] Data string para validación:', dataString.substring(0, 100) + '...');

      // 2. Calcular HMAC-SHA1 con el auth token
      const expectedSignature = crypto
        .createHmac('sha1', authToken)
        .update(dataString, 'utf-8')
        .digest('base64');

      if (expectedSignature.length !== twilioSignature.length) return false;
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(twilioSignature)
      );

    } catch (error) {
      console.error('[TwilioValidation] Error al validar firma:', error);
      return false;
    }
  }

  /**
   * Validates Twilio application/json webhooks. Twilio signs the full URL,
   * including bodySHA256, and separately requires that query value to match
   * the exact raw request body.
   */
  static validateJsonSignature(
    url: string,
    rawBody: string,
    twilioSignature: string,
    authToken: string
  ): boolean {
    try {
      const bodyHash = new URL(url).searchParams.get('bodySHA256');
      if (!bodyHash || !/^[a-f0-9]{64}$/i.test(bodyHash)) {
        return false;
      }

      const expectedBodyHash = crypto
        .createHash('sha256')
        .update(rawBody, 'utf-8')
        .digest('hex');
      if (!crypto.timingSafeEqual(
        Buffer.from(expectedBodyHash),
        Buffer.from(bodyHash.toLowerCase())
      )) {
        return false;
      }

      const expectedSignature = crypto
        .createHmac('sha1', authToken)
        .update(url, 'utf-8')
        .digest('base64');
      if (expectedSignature.length !== twilioSignature.length) {
        return false;
      }
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(twilioSignature)
      );
    } catch (error) {
      console.error('[TwilioValidation] Error validating JSON signature:', error);
      return false;
    }
  }

  /**
   * Desencripta un token usando la utilidad compartida de desencriptación
   */
  private static decryptToken(encryptedValue: string): string | null {
    return decryptToken(encryptedValue);
  }
} 