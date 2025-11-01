/**
 * Servicio para validar peticiones de Twilio usando su signature validation
 */

import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import CryptoJS from 'crypto-js';

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
      
      // Buscar en secure_tokens donde identifier contenga el número de WhatsApp
      const { data: tokens, error } = await supabaseAdmin
        .from('secure_tokens')
        .select('*')
        .eq('site_id', siteId)
        .eq('token_type', 'twilio_whatsapp')
        .like('identifier', `%${whatsappNumber}%`);

      if (error) {
        console.error('[TwilioValidation] Error en consulta a base de datos:', error);
        return {
          success: false,
          error: `Database error: ${error.message}`
        };
      }

      if (!tokens || tokens.length === 0) {
        console.log('[TwilioValidation] No se encontró token para este número');
        return {
          success: false,
          error: `No Twilio auth token found for WhatsApp number ${whatsappNumber} in site ${siteId}`
        };
      }

      // Tomar el primer token encontrado
      const tokenRecord = tokens[0];
      console.log('[TwilioValidation] Token encontrado, desencriptando...');

      // Desencriptar el token
      const decryptedToken = this.decryptToken(tokenRecord.encrypted_value || tokenRecord.value);
      
      if (!decryptedToken) {
        return {
          success: false,
          error: 'Failed to decrypt auth token'
        };
      }

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
  private static validateSignature(
    url: string,
    postData: Record<string, any>,
    twilioSignature: string,
    authToken: string
  ): boolean {
    try {
      // 1. Crear la cadena de datos ordenados
      let dataString = url;
      
      // Ordenar las claves alfabéticamente y concatenar
      const sortedKeys = Object.keys(postData).sort();
      for (const key of sortedKeys) {
        dataString += key + postData[key];
      }

      console.log('[TwilioValidation] Data string para validación:', dataString.substring(0, 100) + '...');

      // 2. Calcular HMAC-SHA1 con el auth token
      const expectedSignature = crypto
        .createHmac('sha1', authToken)
        .update(dataString, 'utf-8')
        .digest('base64');

      console.log('[TwilioValidation] Firma esperada:', expectedSignature);
      console.log('[TwilioValidation] Firma recibida:', twilioSignature);

      // 3. Comparar las firmas de forma segura
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
   * Desencripta un token usando la misma lógica que EmailConfigService
   */
  private static decryptToken(encryptedValue: string): string | null {
    try {
      const encryptionKey = process.env.ENCRYPTION_KEY;
      
      if (!encryptionKey) {
        console.error('[TwilioValidation] Missing ENCRYPTION_KEY environment variable');
        return null;
      }
      
      if (encryptedValue.includes(':')) {
        const [salt, encrypted] = encryptedValue.split(':');
        const combinedKey = encryptionKey + salt;
        
        try {
          const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
          const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
          
          if (decryptedText) {
            return decryptedText;
          }
          
          console.error('[TwilioValidation] Decryption produced empty result');
          return null;
        } catch (error) {
          console.error('[TwilioValidation] Error decrypting token:', error instanceof Error ? error.message : 'Unknown error');
          return null;
        }
      }
      
      // If not in salt:encrypted format, try decrypting directly
      try {
        const decrypted = CryptoJS.AES.decrypt(encryptedValue, encryptionKey);
        const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        return decryptedText || null;
      } catch (error) {
        console.error('[TwilioValidation] Error decrypting token (direct format):', error instanceof Error ? error.message : 'Unknown error');
        return null;
      }
      
    } catch (error) {
      console.error('[TwilioValidation] General decryption error:', error instanceof Error ? error.message : 'Unknown error');
      return null;
    }
  }
} 