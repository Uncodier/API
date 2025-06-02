import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

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
  error?: {
    code: string;
    message: string;
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
      if (!this.isValidPhoneNumber(phone_number)) {
        return {
          success: false,
          error: {
            code: 'INVALID_PHONE_NUMBER',
            message: 'Invalid phone number format. Use international format (e.g., +1234567890)'
          }
        };
      }

      // Normalizar número de teléfono (remover espacios, guiones, etc.)
      const normalizedPhone = this.normalizePhoneNumber(phone_number);

      // Formatear el mensaje con información del sitio
      const formattedMessage = this.formatMessage(message, siteInfo, from);

      // Enviar el mensaje usando la API de WhatsApp
      const result = await this.sendWhatsAppMessage(
        normalizedPhone,
        formattedMessage,
        whatsappConfig.phoneNumberId,
        whatsappConfig.accessToken
      );

      if (!result.success) {
        return {
          success: false,
          error: {
            code: 'WHATSAPP_SEND_FAILED',
            message: result.error || 'Failed to send WhatsApp message'
          }
        };
      }
      
      console.log('✅ Mensaje de WhatsApp enviado exitosamente:', {
        messageId: result.messageId,
        to: normalizedPhone,
        from: from || 'AI Assistant'
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
        status: 'sent'
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
   * Obtiene la configuración de WhatsApp desde las variables de entorno o configuración del sitio
   */
  private static async getWhatsAppConfig(siteId: string): Promise<{
    phoneNumberId: string;
    accessToken: string;
  }> {
    // Validar que siteId no sea undefined o null
    if (!siteId) {
      throw new Error('Site ID is required');
    }

    // Primero intentar obtener desde variables de entorno globales
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_API_TOKEN;
    
    if (phoneNumberId && accessToken) {
      return { phoneNumberId, accessToken };
    }

    // Si no están en env, intentar obtener desde configuración del sitio
    try {
      const { data: siteSettings, error } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', siteId)
        .single();
        
      if (error || !siteSettings?.channels?.whatsapp) {
        throw new Error('WhatsApp not configured for this site');
      }
      
      const whatsappSettings = siteSettings.channels.whatsapp;
      
      if (!whatsappSettings.phoneNumberId || !whatsappSettings.accessToken) {
        throw new Error('WhatsApp configuration incomplete');
      }
      
      return {
        phoneNumberId: whatsappSettings.phoneNumberId,
        accessToken: whatsappSettings.accessToken
      };
    } catch (error) {
      throw new Error(`WhatsApp configuration not found: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Envía el mensaje usando la API de WhatsApp Business
   */
  private static async sendWhatsAppMessage(
    phoneNumber: string,
    message: string,
    phoneNumberId: string,
    accessToken: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const apiUrl = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phoneNumber,
          type: 'text',
          text: {
            body: message,
          },
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ Error de API de WhatsApp:', errorData);
        return { 
          success: false, 
          error: `WhatsApp API error: ${errorData.error?.message || response.statusText}` 
        };
      }
      
      const responseData = await response.json();
      
      return { 
        success: true, 
        messageId: responseData.messages?.[0]?.id 
      };
      
    } catch (error) {
      console.error('❌ Error en llamada a API de WhatsApp:', error);
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
   * Formatea el mensaje añadiendo información del sitio
   */
  private static formatMessage(message: string, siteInfo: SiteInfo, from?: string): string {
    return `${message}

—
${from || 'Equipo de'} ${siteInfo.name}`;
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