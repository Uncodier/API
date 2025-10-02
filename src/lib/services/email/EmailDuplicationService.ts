/**
 * EmailDuplicationService - Implementa la lógica robusta de detección de duplicados
 * Basado en la implementación exitosa de email/sync route
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface DuplicationCheckResult {
  isDuplicate: boolean;
  reason?: string;
  existingMessageId?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface EmailAnalysisData {
  subject: string;
  recipient: string;
  sender: string;
  timestamp: Date;
  emailId: string;
  content?: string;
}

export class EmailDuplicationService {
  
  /**
   * Extrae y valida el ID más confiable de un email
   */
  private static extractValidEmailId(email: any): string | null {
    const candidates = [
      email.messageId,
      email.id,
      email.uid,
      email.message_id,
      email.Message_ID,
      email.ID
    ];
    
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    
    return null;
  }

  /**
   * Normaliza texto para comparaciones consistentes
   */
  private static normalizeText(text: string): string {
    return text.toLowerCase().trim();
  }

  /**
   * Extrae dirección de email limpia
   */
  private static extractEmailAddress(emailField: string): string {
    if (!emailField || typeof emailField !== 'string') {
      return '';
    }
    
    // Buscar email entre < >
    const angleMatch = emailField.match(/<([^>]+)>/);
    if (angleMatch) {
      return angleMatch[1].trim();
    }
    
    // Si no hay < >, buscar patrón de email directo
    const emailMatch = emailField.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      return emailMatch[0].trim();
    }
    
    return emailField.trim();
  }

  /**
   * Analiza un email para detectar duplicados usando la lógica robusta del sync
   */
  static async checkEmailDuplication(
    email: any,
    conversationId: string,
    leadId: string,
    siteId: string
  ): Promise<DuplicationCheckResult> {
    try {
      console.log(`[EMAIL_DUPLICATION] 🔍 Verificando duplicados para email: ${email.subject}`);
      
      // Extraer datos del email
      const analysisData = this.extractEmailAnalysisData(email);
      
      // Buscar mensajes existentes en la conversación
      const existingMessages = await this.getExistingEmailMessages(conversationId, leadId);
      
      if (existingMessages.length === 0) {
        console.log(`[EMAIL_DUPLICATION] ✅ No hay mensajes previos en la conversación`);
        return { isDuplicate: false, confidence: 'high' };
      }

      console.log(`[EMAIL_DUPLICATION] 📊 Analizando ${existingMessages.length} mensajes existentes`);

      // SOLO usar métodos de alta confianza para evitar falsos positivos
      
      // 1. VERIFICACIÓN EXACTA: email_id (más confiable)
      const exactIdMatch = this.checkExactIdMatch(analysisData, existingMessages);
      if (exactIdMatch.isDuplicate) {
        console.log(`[EMAIL_DUPLICATION] 🎯 DUPLICADO CONFIRMADO por ID exacto`);
        return exactIdMatch;
      }

      // 2. VERIFICACIÓN EXACTA: subject + recipient + timestamp MUY cercano (solo 2 minutos)
      const exactMatch = this.checkExactMatchConservative(analysisData, existingMessages);
      if (exactMatch.isDuplicate) {
        console.log(`[EMAIL_DUPLICATION] 🎯 DUPLICADO CONFIRMADO por coincidencia exacta`);
        return exactMatch;
      }

      // 3. VERIFICACIÓN POR RECIPIENT Y PROXIMIDAD TEMPORAL MUY ESTRICTA (solo 10 minutos)
      const recipientMatch = this.checkRecipientTemporalMatchConservative(analysisData, existingMessages);
      if (recipientMatch.isDuplicate) {
        console.log(`[EMAIL_DUPLICATION] 🎯 DUPLICADO CONFIRMADO por recipient + tiempo muy cercano`);
        return recipientMatch;
      }

      console.log(`[EMAIL_DUPLICATION] ✅ No se encontraron duplicados - email es NUEVO`);
      return { isDuplicate: false, confidence: 'high' };

    } catch (error) {
      console.error(`[EMAIL_DUPLICATION] ❌ Error verificando duplicados:`, error);
      return { isDuplicate: false, confidence: 'low' };
    }
  }

  /**
   * Extrae datos de análisis del email
   */
  private static extractEmailAnalysisData(email: any): EmailAnalysisData {
    const subject = email.subject ? this.normalizeText(email.subject) : '';
    const recipient = email.to ? this.extractEmailAddress(email.to) : '';
    const sender = email.from ? this.extractEmailAddress(email.from) : '';
    const timestamp = email.date ? new Date(email.date) : new Date();
    const emailId = this.extractValidEmailId(email) || '';

    return {
      subject,
      recipient,
      sender,
      timestamp,
      emailId,
      content: email.text || email.body || ''
    };
  }

  /**
   * Obtiene mensajes de email existentes en la conversación
   */
  private static async getExistingEmailMessages(conversationId: string, leadId: string): Promise<any[]> {
    try {
      const { data: messages, error } = await supabaseAdmin
        .from('messages')
        .select('id, custom_data, created_at, role, content')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .not('custom_data', 'is', null)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true })
        .limit(100);

      if (error) {
        console.error('[EMAIL_DUPLICATION] Error obteniendo mensajes:', error);
        return [];
      }

      // Filtrar mensajes de email enviados
      return messages.filter(msg => {
        try {
          const customData = msg.custom_data;
          if (!customData || typeof customData !== 'object') return false;
          
          const isEmailChannel = customData.delivery?.channel === 'email' || customData.channel === 'email';
          const isSentStatus = customData.status === 'sent' || customData.delivery?.success === true;
          
          return isEmailChannel && isSentStatus;
        } catch (error) {
          return false;
        }
      });

    } catch (error) {
      console.error('[EMAIL_DUPLICATION] Error procesando mensajes:', error);
      return [];
    }
  }

  /**
   * Verifica coincidencia exacta por email ID
   */
  private static checkExactIdMatch(analysisData: EmailAnalysisData, existingMessages: any[]): DuplicationCheckResult {
    if (!analysisData.emailId) {
      return { isDuplicate: false, confidence: 'low' };
    }

    for (const msg of existingMessages) {
      const customData = msg.custom_data || {};
      const existingEmailId = customData.email_id || 
                             customData.delivery?.details?.api_messageId || 
                             customData.delivery?.external_message_id;

      if (existingEmailId && analysisData.emailId === existingEmailId) {
        console.log(`[EMAIL_DUPLICATION] ✅ DUPLICADO EXACTO por email_id: ${msg.id}`);
        return {
          isDuplicate: true,
          reason: `Duplicado exacto por email_id: "${analysisData.emailId}"`,
          existingMessageId: msg.id,
          confidence: 'high'
        };
      }
    }

    return { isDuplicate: false, confidence: 'high' };
  }

  /**
   * Verifica coincidencia exacta por subject + recipient + timestamp (VERSIÓN CONSERVADORA)
   */
  private static checkExactMatchConservative(analysisData: EmailAnalysisData, existingMessages: any[]): DuplicationCheckResult {
    if (!analysisData.subject || !analysisData.recipient) {
      return { isDuplicate: false, confidence: 'low' };
    }

    for (const msg of existingMessages) {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      
      const existingSubject = this.normalizeText(deliveryDetails.subject || customData.subject || '');
      const existingRecipient = this.normalizeText(deliveryDetails.recipient || '');
      const existingTimestamp = deliveryDetails.timestamp ? new Date(deliveryDetails.timestamp) : new Date(msg.created_at);

      if (analysisData.subject === existingSubject && analysisData.recipient === existingRecipient) {
        const timeDiff = Math.abs(analysisData.timestamp.getTime() - existingTimestamp.getTime());
        const twoMinutes = 2 * 60 * 1000; // MUCHO más estricto: solo 2 minutos

        if (timeDiff <= twoMinutes) {
          console.log(`[EMAIL_DUPLICATION] ✅ DUPLICADO EXACTO (conservador) por subject+recipient+timestamp: ${msg.id}`);
          console.log(`[EMAIL_DUPLICATION] 📊 Detalles: subject="${analysisData.subject}", recipient="${analysisData.recipient}", timeDiff=${Math.round(timeDiff/1000)}s`);
          return {
            isDuplicate: true,
            reason: `Duplicado exacto (conservador): mismo subject, recipient y timestamp muy cercano (${Math.round(timeDiff/1000)}s)`,
            existingMessageId: msg.id,
            confidence: 'high'
          };
        }
      }
    }

    return { isDuplicate: false, confidence: 'high' };
  }

  /**
   * Verifica coincidencia exacta por subject + recipient + timestamp (VERSIÓN ORIGINAL)
   */
  private static checkExactMatch(analysisData: EmailAnalysisData, existingMessages: any[]): DuplicationCheckResult {
    if (!analysisData.subject || !analysisData.recipient) {
      return { isDuplicate: false, confidence: 'low' };
    }

    for (const msg of existingMessages) {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      
      const existingSubject = this.normalizeText(deliveryDetails.subject || customData.subject || '');
      const existingRecipient = this.normalizeText(deliveryDetails.recipient || '');
      const existingTimestamp = deliveryDetails.timestamp ? new Date(deliveryDetails.timestamp) : new Date(msg.created_at);

      if (analysisData.subject === existingSubject && analysisData.recipient === existingRecipient) {
        const timeDiff = Math.abs(analysisData.timestamp.getTime() - existingTimestamp.getTime());
        const fiveMinutes = 5 * 60 * 1000;

        if (timeDiff <= fiveMinutes) {
          console.log(`[EMAIL_DUPLICATION] ✅ DUPLICADO EXACTO por subject+recipient+timestamp: ${msg.id}`);
          return {
            isDuplicate: true,
            reason: `Duplicado exacto: mismo subject, recipient y timestamp (${Math.round(timeDiff/1000)}s)`,
            existingMessageId: msg.id,
            confidence: 'high'
          };
        }
      }
    }

    return { isDuplicate: false, confidence: 'high' };
  }

  /**
   * Verifica coincidencia por análisis de rangos temporales
   */
  private static checkTemporalRangeMatch(analysisData: EmailAnalysisData, existingMessages: any[]): DuplicationCheckResult {
    if (!analysisData.subject) {
      return { isDuplicate: false, confidence: 'low' };
    }

    // Filtrar mensajes con el mismo subject
    const sameSubjectMessages = existingMessages.filter(msg => {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      const existingSubject = this.normalizeText(deliveryDetails.subject || customData.subject || '');
      return existingSubject === analysisData.subject;
    });

    if (sameSubjectMessages.length < 2) {
      return { isDuplicate: false, confidence: 'medium' };
    }

    // Ordenar por timestamp
    sameSubjectMessages.sort((a, b) => {
      const aTime = a.custom_data?.delivery?.details?.timestamp ? new Date(a.custom_data.delivery.details.timestamp) : new Date(a.created_at);
      const bTime = b.custom_data?.delivery?.details?.timestamp ? new Date(b.custom_data.delivery.details.timestamp) : new Date(b.created_at);
      return aTime.getTime() - bTime.getTime();
    });

    // Verificar si el email actual encaja en algún rango temporal
    for (let i = 0; i < sameSubjectMessages.length - 1; i++) {
      const msg1 = sameSubjectMessages[i];
      const msg2 = sameSubjectMessages[i + 1];
      
      const time1 = msg1.custom_data?.delivery?.details?.timestamp ? new Date(msg1.custom_data.delivery.details.timestamp) : new Date(msg1.created_at);
      const time2 = msg2.custom_data?.delivery?.details?.timestamp ? new Date(msg2.custom_data.delivery.details.timestamp) : new Date(msg2.created_at);

      if (analysisData.timestamp.getTime() > time1.getTime() && analysisData.timestamp.getTime() < time2.getTime()) {
        const gap1 = analysisData.timestamp.getTime() - time1.getTime();
        const gap2 = time2.getTime() - analysisData.timestamp.getTime();
        const totalGap = time2.getTime() - time1.getTime();

        if (gap1 > 1000 && gap2 > 1000 && totalGap < 24 * 60 * 60 * 1000) {
          const recipient1 = this.normalizeText(msg1.custom_data?.delivery?.details?.recipient || '');
          const recipient2 = this.normalizeText(msg2.custom_data?.delivery?.details?.recipient || '');

          if (analysisData.recipient === recipient1 || analysisData.recipient === recipient2) {
            const matchingMsg = analysisData.recipient === recipient1 ? msg1 : msg2;
            console.log(`[EMAIL_DUPLICATION] ✅ DUPLICADO POR RANGO TEMPORAL: ${matchingMsg.id}`);
            
            return {
              isDuplicate: true,
              reason: `Duplicado por rango temporal: mismo subject y recipient en secuencia temporal`,
              existingMessageId: matchingMsg.id,
              confidence: 'medium'
            };
          }
        }
      }
    }

    return { isDuplicate: false, confidence: 'medium' };
  }

  /**
   * Verifica coincidencia por recipient y proximidad temporal (VERSIÓN CONSERVADORA)
   */
  private static checkRecipientTemporalMatchConservative(analysisData: EmailAnalysisData, existingMessages: any[]): DuplicationCheckResult {
    if (!analysisData.recipient) {
      return { isDuplicate: false, confidence: 'low' };
    }

    const sameRecipientMessages = existingMessages.filter(msg => {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      const existingRecipient = this.normalizeText(deliveryDetails.recipient || '');
      return existingRecipient === analysisData.recipient;
    });

    for (const msg of sameRecipientMessages) {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      const existingTimestamp = deliveryDetails.timestamp ? new Date(deliveryDetails.timestamp) : new Date(msg.created_at);
      
      const timeDiff = Math.abs(analysisData.timestamp.getTime() - existingTimestamp.getTime());
      const tenMinutes = 10 * 60 * 1000; // MUCHO más estricto: solo 10 minutos

      if (timeDiff < tenMinutes) {
        console.log(`[EMAIL_DUPLICATION] ✅ DUPLICADO POR RECIPIENT+TIEMPO (conservador): ${msg.id}`);
        console.log(`[EMAIL_DUPLICATION] 📊 Detalles: recipient="${analysisData.recipient}", timeDiff=${Math.round(timeDiff/1000/60)} min`);
        return {
          isDuplicate: true,
          reason: `Duplicado por recipient y proximidad temporal muy cercana: "${analysisData.recipient}" (${Math.round(timeDiff/1000/60)} min)`,
          existingMessageId: msg.id,
          confidence: 'medium'
        };
      }
    }

    return { isDuplicate: false, confidence: 'medium' };
  }

  /**
   * Verifica coincidencia por recipient y proximidad temporal (VERSIÓN ORIGINAL)
   */
  private static checkRecipientTemporalMatch(analysisData: EmailAnalysisData, existingMessages: any[]): DuplicationCheckResult {
    if (!analysisData.recipient) {
      return { isDuplicate: false, confidence: 'low' };
    }

    const sameRecipientMessages = existingMessages.filter(msg => {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      const existingRecipient = this.normalizeText(deliveryDetails.recipient || '');
      return existingRecipient === analysisData.recipient;
    });

    for (const msg of sameRecipientMessages) {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      const existingTimestamp = deliveryDetails.timestamp ? new Date(deliveryDetails.timestamp) : new Date(msg.created_at);
      
      const timeDiff = Math.abs(analysisData.timestamp.getTime() - existingTimestamp.getTime());
      const oneHour = 60 * 60 * 1000;

      if (timeDiff < oneHour) {
        console.log(`[EMAIL_DUPLICATION] ✅ DUPLICADO POR RECIPIENT+TIEMPO: ${msg.id}`);
        return {
          isDuplicate: true,
          reason: `Duplicado por recipient y proximidad temporal: "${analysisData.recipient}" (${Math.round(timeDiff/1000/60)} min)`,
          existingMessageId: msg.id,
          confidence: 'medium'
        };
      }
    }

    return { isDuplicate: false, confidence: 'medium' };
  }
}
