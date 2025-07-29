import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';
import { WhatsAppTemplateService } from './WhatsAppTemplateService';
import { attemptPhoneRescue } from '@/lib/utils/phone-normalizer';

export interface SendWhatsAppParams {
  phone_number: string;
  message: string;
  from?: string; // Nombre del remitente (opcional)
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  site_id: string;
}

export interface SendWhatsAppResult {
  success: boolean;
  message_id?: string;
  recipient?: string;
  sender?: string;
  message_preview?: string;
  sent_at?: string;
  status?: string;
  reason?: string;
  template_used?: boolean;
  template_sid?: string;
  within_response_window?: boolean;
  hours_elapsed?: number;
  error?: {
    code: string;
    message: string;
  };
  // Nuevos campos para manejo de errores de Twilio
  errorCode?: number;
  errorType?: string;
  suggestion?: string;
  // Nuevos campos para template_required
  template_required?: boolean;
  formatted_message?: string;
  whatsapp_config?: {
    phone_number_id: string;
    access_token: string;
    from_number: string;
  };
}

interface SiteInfo {
  name: string;
  url?: string;
}

export class WhatsAppSendService {
  /**
   * Envía un mensaje de WhatsApp usando la API de WhatsApp Business
   */
  static async sendMessage(params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    const { phone_number, message, from, agent_id, conversation_id, lead_id, site_id } = params;
    
    // Si el número es temporal, no enviar mensaje real
    if (phone_number === 'no-phone-example' || phone_number === '+00000000000') {
      console.log('📱 Número temporal detectado, no se enviará mensaje real:', {
        to: phone_number,
        from: from || 'AI Assistant',
        messagePreview: message.substring(0, 100) + '...'
      });
      
      return {
        success: true,
        message_id: uuidv4(),
        recipient: phone_number,
        sender: from || 'AI Assistant',
        message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        sent_at: new Date().toISOString(),
        status: 'skipped',
        reason: 'Temporary phone number - no real message sent'
      };
    }

    try {
      // Obtener información del sitio
      const siteInfo = await this.getSiteInfo(site_id);
      
      // Obtener configuración de WhatsApp para el sitio
      const whatsappConfig = await this.getWhatsAppConfig(site_id);
      
      // Validar formato del número de teléfono
      let validatedPhone = phone_number;
      
      if (!this.isValidPhoneNumber(phone_number)) {
        console.log(`⚠️ [WhatsAppSendService] Número inválido detectado, intentando rescate: ${phone_number}`);
        
        // Intentar rescatar el número usando heurísticas
        const rescuedPhone = attemptPhoneRescue(phone_number);
        
        if (rescuedPhone && this.isValidPhoneNumber(rescuedPhone)) {
          validatedPhone = rescuedPhone;
          console.log(`✅ [WhatsAppSendService] Número rescatado exitosamente: ${phone_number} -> ${rescuedPhone}`);
        } else {
          console.error(`❌ [WhatsAppSendService] No se pudo rescatar el número: ${phone_number}`);
          return {
            success: false,
            error: {
              code: 'INVALID_PHONE_NUMBER',
              message: `Invalid phone number format: "${phone_number}". Use international format (e.g., +1234567890). Attempted rescue but failed.`
            }
          };
        }
      }

      // Normalizar número de teléfono (remover espacios, guiones, etc.)
      const normalizedPhone = this.normalizePhoneNumber(validatedPhone);

      // Formatear el mensaje con información del sitio
      const formattedMessage = this.formatMessage(message, siteInfo, from);

      // ** NUEVA FUNCIONALIDAD: Verificar ventana de respuesta y usar templates si es necesario **
      console.log('🕐 [WhatsAppSendService] Verificando ventana de respuesta...');
      
      const windowCheck = await WhatsAppTemplateService.checkResponseWindow(
        conversation_id || null,
        normalizedPhone,
        site_id
      );
      
      console.log(`⏰ [WhatsAppSendService] Resultado de ventana:`, {
        withinWindow: windowCheck.withinWindow,
        hoursElapsed: windowCheck.hoursElapsed,
        requiresTemplate: !windowCheck.withinWindow
      });

      let result: { success: boolean; messageId?: string; error?: string; errorCode?: number; errorType?: string; suggestion?: string } | undefined;
      let templateUsed = false;
      let templateSid: string | undefined;

      if (!windowCheck.withinWindow) {
        // Fuera de ventana de respuesta - retornar que se requiere template
        console.log('📝 [WhatsAppSendService] Fuera de ventana de respuesta, se requiere template...');
        
        // Generar un message_id único para el flujo
        const messageId = uuidv4();
        
        console.log(`🔄 [WhatsAppSendService] Retornando template_required para que el flujo maneje la creación: ${messageId}`);
        
        // Retornar información para que el flujo maneje la creación del template
        return {
          success: true,
          message_id: messageId,
          recipient: normalizedPhone,
          sender: from || 'AI Assistant',
          message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
          sent_at: new Date().toISOString(),
          status: 'template_required',
          template_used: false,
          template_sid: undefined,
          within_response_window: false,
          hours_elapsed: windowCheck.hoursElapsed,
          template_required: true,
          formatted_message: formattedMessage,
          whatsapp_config: {
            phone_number_id: whatsappConfig.phoneNumberId,
            access_token: whatsappConfig.accessToken,
            from_number: whatsappConfig.fromNumber
          }
        };
      } else {
        // Dentro de ventana de respuesta - enviar mensaje regular
        console.log('✅ [WhatsAppSendService] Dentro de ventana de respuesta, enviando mensaje regular...');
        const regularResult = await this.sendWhatsAppMessage(
          normalizedPhone,
          formattedMessage,
          whatsappConfig.phoneNumberId,
          whatsappConfig.accessToken,
          whatsappConfig.fromNumber
        );
        
        // Mapear resultado al formato esperado
        result = {
          success: regularResult.success,
          messageId: regularResult.messageId,
          error: regularResult.error,
          errorCode: regularResult.errorCode,
          errorType: regularResult.errorType,
          suggestion: regularResult.suggestion
        };
      }

      // Validar que result no sea undefined (solo para mensajes dentro de ventana)
      if (!result) {
        console.error('❌ [WhatsAppSendService] No se pudo obtener resultado del envío');
        return {
          success: false,
          error: {
            code: 'SEND_FAILED',
            message: 'No se pudo enviar el mensaje por WhatsApp'
          }
        };
      }

      if (!result.success) {
        return {
          success: false,
          error: {
            code: 'WHATSAPP_SEND_FAILED',
            message: result.error || 'Failed to send WhatsApp message'
          },
          errorCode: result.errorCode,
          errorType: result.errorType,
          suggestion: result.suggestion
        };
      }
      
      console.log('✅ Mensaje de WhatsApp enviado exitosamente:', {
        messageId: result.messageId,
        to: normalizedPhone,
        from: from || 'AI Assistant',
        templateUsed,
        templateSid,
        withinWindow: windowCheck.withinWindow
      });

      // Guardar registro del mensaje enviado en la base de datos
      await this.saveWhatsAppLog({
        recipient_phone: normalizedPhone,
        sender_name: from || 'AI Assistant',
        message_content: formattedMessage,
        agent_id,
        conversation_id,
        lead_id,
        whatsapp_message_id: result.messageId || 'unknown'
      });
      
      return {
        success: true,
        message_id: result.messageId || 'unknown',
        recipient: normalizedPhone,
        sender: from || 'AI Assistant',
        message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        sent_at: new Date().toISOString(),
        status: 'sent',
        template_used: templateUsed,
        template_sid: templateSid,
        within_response_window: windowCheck.withinWindow,
        hours_elapsed: windowCheck.hoursElapsed
      };

    } catch (error) {
      console.error('Error enviando mensaje de WhatsApp:', error);
      
      const isConfigError = error instanceof Error && (
        error.message.includes('settings') || 
        error.message.includes('token') ||
        error.message.includes('WhatsApp not configured')
      );
      
      return {
        success: false,
        error: {
          code: isConfigError ? 'WHATSAPP_CONFIG_NOT_FOUND' : 'WHATSAPP_SEND_FAILED',
          message: isConfigError 
            ? `WhatsApp configuration not found for site ${site_id}. Please configure WhatsApp settings in site settings.`
            : error instanceof Error ? error.message : 'Failed to send WhatsApp message'
        }
      };
    }
  }

  /**
   * Obtiene la configuración de WhatsApp desde las variables de entorno o secure_tokens
   */
  private static async getWhatsAppConfig(siteId: string): Promise<{
    phoneNumberId: string;
    accessToken: string;
    fromNumber: string;
  }> {
    // Validar que siteId no sea undefined o null
    if (!siteId) {
      throw new Error('Site ID is required');
    }

    console.log(`🔍 [WhatsAppSendService] Buscando configuración de WhatsApp para site_id: ${siteId}`);

    // Primero intentar obtener desde variables de entorno globales
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_API_TOKEN;
    
    if (phoneNumberId && accessToken) {
      console.log('✅ [WhatsAppSendService] Usando configuración de variables de entorno');
      return { phoneNumberId, accessToken, fromNumber: process.env.TWILIO_WHATSAPP_FROM || '+14155238886' };
    }

    // Si no están en env, buscar y desencriptar desde secure_tokens
    try {
      console.log('🔎 [WhatsAppSendService] Buscando en secure_tokens...');
      
      const decryptedToken = await this.getTokenFromService(siteId);
      
      if (decryptedToken) {
        console.log('✅ [WhatsAppSendService] Token desencriptado exitosamente desde secure_tokens');
        
        console.log('🔍 [WhatsAppSendService] Contenido del token desencriptado:');
        console.log('- Tipo:', typeof decryptedToken);
        console.log('- Longitud:', decryptedToken?.length || 'N/A');
        console.log('- Primeros 20 caracteres:', typeof decryptedToken === 'string' ? decryptedToken.substring(0, 20) + '...' : JSON.stringify(decryptedToken).substring(0, 20));
        
        // El token desencriptado es directamente el auth token de Twilio
        const authToken = typeof decryptedToken === 'string' ? decryptedToken : String(decryptedToken);
        
        // Obtener el Account SID desde settings.channels.whatsapp
        console.log('🔍 [WhatsAppSendService] Obteniendo Account SID desde settings...');
        
        const { data: siteSettings, error: settingsError } = await supabaseAdmin
          .from('settings')
          .select('channels')
          .eq('site_id', siteId)
          .single();
          
        if (settingsError || !siteSettings?.channels?.whatsapp) {
          console.error('❌ [WhatsAppSendService] No se pudo obtener settings para Account SID:', settingsError);
          throw new Error('No se pudo obtener Account SID desde settings');
        }
        
        const accountSid = siteSettings.channels.whatsapp.account_sid;
        
        console.log('📋 [WhatsAppSendService] Credenciales obtenidas:', {
          hasAccountSid: !!accountSid,
          hasAuthToken: !!authToken,
          accountSidPreview: accountSid ? accountSid.substring(0, 10) + '...' : 'No encontrado',
          authTokenPreview: authToken ? authToken.substring(0, 10) + '...' : 'No encontrado',
          whatsappConfig: siteSettings.channels.whatsapp
        });
        
        if (!accountSid || !authToken) {
          throw new Error('AccountSid or AuthToken missing - accountSid debe estar en settings.channels.whatsapp.account_sid');
        }
        
        return {
          phoneNumberId: accountSid, 
          accessToken: authToken,
          fromNumber: siteSettings.channels.whatsapp.existingNumber
        };
      } else {
        console.log('❌ [WhatsAppSendService] No se pudo desencriptar el token desde secure_tokens');
        throw new Error('WhatsApp configuration not found in secure_tokens');
      }

    } catch (error) {
      console.error('❌ [WhatsAppSendService] Error obteniendo configuración de WhatsApp:', error);
      
      // Si falla secure_tokens, intentar fallback con settings (configuración anterior)
      try {
        console.log('🔄 [WhatsAppSendService] Intentando fallback con settings...');
        
        const { data: siteSettings, error: settingsError } = await supabaseAdmin
          .from('settings')
          .select('channels')
          .eq('site_id', siteId)
          .single();
          
        if (settingsError || !siteSettings?.channels?.whatsapp) {
          throw new Error('WhatsApp not configured in settings either');
        }
        
        const whatsappSettings = siteSettings.channels.whatsapp;
        
        if (!whatsappSettings.phoneNumberId || !whatsappSettings.accessToken) {
          throw new Error('WhatsApp configuration incomplete in settings');
        }
        
        console.log('✅ [WhatsAppSendService] Usando configuración de settings como fallback');
        
        return {
          phoneNumberId: whatsappSettings.phoneNumberId,
          accessToken: whatsappSettings.accessToken,
          fromNumber: whatsappSettings.existingNumber
        };
      } catch (fallbackError) {
        console.error('❌ [WhatsAppSendService] Fallback también falló:', fallbackError);
        throw new Error(`WhatsApp configuration not found: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  /**
   * Obtiene y desencripta el token directamente desde la base de datos
   */
  private static async getTokenFromService(siteId: string): Promise<any | null> {
    try {
      console.log('🔓 [WhatsAppSendService] Obteniendo token directamente desde base de datos...');
      
      // 1. PRIMERO: Intentar obtener directamente de la base de datos (MÁS RÁPIDO)
      const { data, error } = await supabaseAdmin
        .from('secure_tokens')
        .select('*')
        .eq('site_id', siteId)
        .eq('token_type', 'twilio_whatsapp')
        .maybeSingle();
      
      if (error || !data) {
        if (error) {
          console.error('❌ [WhatsAppSendService] Error consultando secure_tokens:', error);
        } else {
          console.log('⚠️ [WhatsAppSendService] No se encontró token en secure_tokens, intentando servicio HTTP...');
        }
        
        // 2. FALLBACK: Intentar obtener del servicio de desencriptación HTTP (MÁS LENTO)
        try {
          const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || 'http://localhost:3000';
          const decryptUrl = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
          
          const response = await fetch(decryptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              site_id: siteId,
              token_type: 'twilio_whatsapp'
            })
          });
          
          const result = await response.json();
          
          if (response.ok && result.success && result.data?.tokenValue) {
            console.log('✅ [WhatsAppSendService] Token obtenido del servicio HTTP como fallback');
            const decryptedValue = result.data.tokenValue;
            return typeof decryptedValue === 'object' ? decryptedValue : JSON.parse(decryptedValue);
          }
        } catch (httpError) {
          console.log('❌ [WhatsAppSendService] Servicio HTTP también falló:', httpError);
        }
        
        return null;
      }
      
      console.log('📊 [WhatsAppSendService] Token encontrado en base de datos:', {
        id: data.id,
        hasEncryptedValue: !!data.encrypted_value,
        hasValue: !!data.value,
        hasTokenValue: !!data.token_value
      });
      
      // 3. Determinar qué campo usar para desencriptar
      let encryptedValue;
      if (data.encrypted_value) {
        encryptedValue = data.encrypted_value;
      } else if (data.value && typeof data.value === 'string' && data.value.includes(':')) {
        encryptedValue = data.value;
      } else if (data.token_value && typeof data.token_value === 'string' && data.token_value.includes(':')) {
        encryptedValue = data.token_value;
      } else {
        console.log('❌ [WhatsAppSendService] No se encontró valor encriptado válido');
        return null;
      }
      
      console.log('🔐 [WhatsAppSendService] Desencriptando token...');
      
      // 4. Desencriptar el token
      const decryptedValue = this.decryptToken(encryptedValue);
      
      if (!decryptedValue) {
        console.log('❌ [WhatsAppSendService] Falló la desencriptación');
        return null;
      }
      
      console.log('✅ [WhatsAppSendService] Token desencriptado exitosamente');
      
      // 5. Actualizar last_used si el campo existe
      if (data.hasOwnProperty('last_used')) {
        await supabaseAdmin
          .from('secure_tokens')
          .update({ last_used: new Date().toISOString() })
          .eq('id', data.id);
      }
      
      // 6. Intentar parsear como JSON
      try {
        return JSON.parse(decryptedValue);
      } catch (jsonError) {
        // Si no es JSON, retornar como string
        console.log('⚠️ [WhatsAppSendService] Token no es JSON, retornando como string:', decryptedValue);
        return decryptedValue;
      }
      
    } catch (error) {
      console.error('❌ [WhatsAppSendService] Error obteniendo/desencriptando token:', error);
      return null;
    }
  }

  /**
   * Desencripta un token usando CryptoJS con el mismo patrón que EmailConfigService
   */
  private static decryptToken(encryptedValue: string): string | null {
    const encryptionKey = process.env.ENCRYPTION_KEY || '';
    
    if (!encryptionKey) {
      console.error('❌ [WhatsAppSendService] ENCRYPTION_KEY no está configurada');
      return null;
    }
    
    if (encryptedValue.includes(':')) {
      const [salt, encrypted] = encryptedValue.split(':');
      const combinedKey = encryptionKey + salt;
      
      try {
        console.log('🔑 [WhatsAppSendService] Intentando desencriptar con clave del environment...');
        // 1. Intentar con la clave del environment
        const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
        const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        
        if (decryptedText) {
          console.log('✅ [WhatsAppSendService] Desencriptado exitosamente con clave del environment');
          return decryptedText;
        }

        throw new Error("La desencriptación produjo un texto vacío");
      } catch (error) {
        try {
          console.log('🔑 [WhatsAppSendService] Intentando con clave fija original...');
          // 2. Intentar con la clave fija original
          const originalKey = 'Encryption-key';
          const decrypted = CryptoJS.AES.decrypt(encrypted, originalKey + salt);
          const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
          
          if (decryptedText) {
            console.log('✅ [WhatsAppSendService] Desencriptado exitosamente con clave original');
            return decryptedText;
          }
          
          throw new Error("La desencriptación produjo un texto vacío con clave original");
        } catch (errorOriginal) {
          // 3. Intentar con clave alternativa en desarrollo
          const altEncryptionKey = process.env.ALT_ENCRYPTION_KEY;
          if (altEncryptionKey && process.env.NODE_ENV === 'development') {
            try {
              console.log('🔑 [WhatsAppSendService] Intentando con clave alternativa de desarrollo...');
              const altCombinedKey = altEncryptionKey + salt;
              const decrypted = CryptoJS.AES.decrypt(encrypted, altCombinedKey);
              const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
              
              if (decryptedText) {
                console.log('✅ [WhatsAppSendService] Desencriptado exitosamente con clave alternativa');
                return decryptedText;
              }
            } catch (altError) {
              console.log('❌ [WhatsAppSendService] Falló clave alternativa también');
            }
          }
          
          console.error('❌ [WhatsAppSendService] No se pudo desencriptar el token con ninguna clave disponible');
          return null;
        }
      }
    }
    
    console.error('❌ [WhatsAppSendService] Formato de token no soportado, se esperaba salt:encrypted');
    return null;
  }

  /**
   * Envía el mensaje usando la API de Twilio WhatsApp
   */
  private static async sendWhatsAppMessage(
    phoneNumber: string,
    message: string,
    accountSid: string,
    authToken: string,
    fromNumber: string
  ): Promise<{ success: boolean; messageId?: string; error?: string; errorCode?: number; errorType?: string; suggestion?: string }> {
    try {
      console.log('📤 [WhatsAppSendService] Enviando via API de Twilio WhatsApp...');
      
      // URL de la API de Twilio para enviar mensajes
      const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      
      // Crear las credenciales de autenticación básica
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      // Preparar el cuerpo de la solicitud como form data
      const formData = new URLSearchParams();
      formData.append('From', `whatsapp:${fromNumber}`);
      formData.append('To', `whatsapp:${phoneNumber}`);
      formData.append('Body', message);
      
      console.log('🔐 [WhatsAppSendService] Datos de envío:', {
        url: apiUrl,
        from: `whatsapp:${fromNumber}`,
        to: `whatsapp:${phoneNumber}`,
        messageLength: message.length
      });
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString()
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        const twilioErrorCode = errorData.code;
        const errorMessage = errorData.message || response.statusText;
        
        console.error('❌ [WhatsAppSendService] Error de API de Twilio:', {
          status: response.status,
          twilioErrorCode,
          errorMessage,
          fullError: errorData,
          to: phoneNumber,
          from: fromNumber
        });
        
        // Usar el mismo sistema de manejo de errores que en WhatsAppTemplateService
        const errorInfo = WhatsAppTemplateService.getTwilioErrorInfo(twilioErrorCode);
        
        console.error(`🚨 [WhatsAppSendService] ERROR ${twilioErrorCode}: ${errorInfo.description}`);
        console.error(`💡 [WhatsAppSendService] Sugerencia: ${errorInfo.suggestion}`);
        
        return { 
          success: false, 
          error: `${errorInfo.description}: ${errorMessage}`,
          errorCode: twilioErrorCode,
          errorType: errorInfo.type,
          suggestion: errorInfo.suggestion
        };
      }
      
      const responseData = await response.json();
      
      console.log('✅ [WhatsAppSendService] Respuesta exitosa de Twilio:', {
        sid: responseData.sid,
        status: responseData.status,
        from: responseData.from,
        to: responseData.to
      });
      
      return { 
        success: true, 
        messageId: responseData.sid 
      };
      
    } catch (error) {
      console.error('❌ [WhatsAppSendService] Error en llamada a API de Twilio:', error);
      return { 
        success: false, 
        error: `Exception: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    }
  }

  /**
   * Obtiene información del sitio desde la base de datos
   */
  private static async getSiteInfo(siteId: string): Promise<SiteInfo> {
    try {
      const { data: site, error } = await supabaseAdmin
        .from('sites')
        .select('name, url')
        .eq('id', siteId)
        .single();

      if (error || !site) {
        console.warn(`No se pudo obtener información del sitio ${siteId}, usando valores por defecto`);
        return { name: 'Nuestro sitio' };
      }

      return {
        name: site.name || 'Nuestro sitio',
        url: site.url
      };
    } catch (error) {
      console.warn(`Error obteniendo información del sitio ${siteId}:`, error);
      return { name: 'Nuestro sitio' };
    }
  }

  /**
   * Formatea el mensaje (actualmente sin modificaciones)
   */
  private static formatMessage(message: string, siteInfo: SiteInfo, from?: string): string {
    return message;
  }

  /**
   * Guarda el log del mensaje enviado en la base de datos
   */
  private static async saveWhatsAppLog(logData: {
    recipient_phone: string;
    sender_name: string;
    message_content: string;
    agent_id?: string;
    conversation_id?: string;
    lead_id?: string;
    whatsapp_message_id: string;
  }): Promise<void> {
    try {
      const whatsappLogData = {
        id: uuidv4(),
        ...logData,
        agent_id: logData.agent_id || null,
        conversation_id: logData.conversation_id || null,
        lead_id: logData.lead_id || null,
        sent_at: new Date().toISOString(),
        status: 'sent'
      };
      
      // Intentar guardar en tabla de logs de WhatsApp (si existe)
      const { error: logError } = await supabaseAdmin
        .from('whatsapp_logs')
        .insert([whatsappLogData]);
      
      if (logError) {
        console.warn('No se pudo guardar el log del mensaje de WhatsApp (tabla posiblemente no existe):', logError.message);
      }
    } catch (logError) {
      console.warn('Error al intentar guardar log del mensaje de WhatsApp:', logError);
    }
  }

  /**
   * Valida el formato de número de teléfono
   */
  static isValidPhoneNumber(phoneNumber: string): boolean {
    // Formato internacional: +[código país][número]
    // Acepta números con + al inicio, seguido de 7-15 dígitos
    const phoneRegex = /^\+[1-9]\d{6,14}$/;
    return phoneRegex.test(phoneNumber.replace(/[\s\-\(\)]/g, ''));
  }

  /**
   * Normaliza el número de teléfono removiendo espacios y caracteres especiales
   */
  private static normalizePhoneNumber(phoneNumber: string): string {
    // Remover espacios, guiones, paréntesis
    let normalized = phoneNumber.replace(/[\s\-\(\)]/g, '');
    
    // Asegurar que comience con +
    if (!normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }
    
    return normalized;
  }
} 