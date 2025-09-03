/**
 * SentEmailDuplicationService - Servicio especializado para detectar y prevenir duplicados en emails enviados
 * Maneja tanto la validación a nivel de base de datos como la validación temporal/semántica
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';
import { StableEmailDeduplicationService } from '@/lib/utils/stable-email-deduplication';

interface EmailValidationResult {
  isDuplicate: boolean;
  reason?: string;
  existingId?: string;
  emailId?: string;
  standardId?: string;
}

interface DebugItem {
  index: number;
  emailTo: any;
  emailSubject: any;
  emailDate: any;
  rawIds: {
    messageId: any;
    id: any;
    uid: any;
  };
  standardEmailId?: string | null;
  decision?: string;
  existsInSyncedObjects?: boolean;
  syncedObjectsError?: string;
  createError?: string;
}

export class SentEmailDuplicationService {
  
  /**
   * Extrae y valida el ID más confiable de un email siguiendo RFC 5322
   */
  static extractStandardEmailId(email: any): string | null {
    console.log(`[SENT_EMAIL_DEDUP] 🔍 Extrayendo ID estándar del email...`);
    
    const candidates = [
      { field: 'messageId', value: email.messageId, priority: 1 }, // 🎯 PRIORIZAR Message-ID para correlación perfecta (RFC 5322)
      { field: 'id', value: email.id, priority: 2 },
      { field: 'uid', value: email.uid, priority: 3 },
      { field: 'message_id', value: email.message_id, priority: 4 },
      { field: 'Message_ID', value: email.Message_ID, priority: 5 },
      { field: 'ID', value: email.ID, priority: 6 }
    ];
    

    
    // Evaluar cada candidato en orden de prioridad
    for (const candidate of candidates) {

      
      if (this.isValidEmailId(candidate.value)) {
        const standardId = candidate.value.trim();

        
        return standardId;
      } else {

      }
    }
    

    
    // 🆕 FALLBACK: Generar ID basado en envelope (para casos donde no hay Message-ID disponible)
    const envelopeId = this.generateEnvelopeBasedId(email);
    if (envelopeId) {

      return envelopeId;
    }
    

    
    return null;
  }

  /**
   * Genera un ID estable basado en datos del envelope (to, from, subject, timestamp)
   * Este ID puede generarse tanto al enviar como al sincronizar desde IMAP
   */
  static generateEnvelopeBasedId(email: any): string | null {
    try {

      
      // Extraer datos requeridos
      const to = email.to || email.recipient;
      const from = email.from || email.sender;
      const subject = email.subject;
      const date = email.date || email.sent_at;
      
      if (!to || !from || !subject || !date) {

        return null;
      }
      
      // Normalizar timestamp a ventana de 1 minuto para manejar diferencias pequeñas
      const timestamp = new Date(date);
      if (isNaN(timestamp.getTime())) {

        return null;
      }
      
      // Redondear a DÍA para crear ventana temporal MÁS estable (emails del mismo día con mismo contenido = duplicados)
      const roundedTime = new Date(timestamp);
      roundedTime.setHours(0, 0, 0, 0); // Reset a medianoche
      const timeWindow = roundedTime.toISOString().substring(0, 10); // YYYY-MM-DD
      
      // 🔧 NORMALIZAR CAMPOS - Extraer solo direcciones de email para consistencia
      const normalizedTo = this.extractEmailAddress(to).toLowerCase().trim();
      const normalizedFrom = this.extractEmailAddress(from).toLowerCase().trim();
      const normalizedSubject = subject.toLowerCase().trim().substring(0, 50); // Primeros 50 chars
      

      
      // Crear hash estable usando SHA-256 simplificado
      const dataString = `${timeWindow}|${normalizedTo}|${normalizedFrom}|${normalizedSubject}`;
      
      // Generar hash simple pero estable
      let hash = 0;
      for (let i = 0; i < dataString.length; i++) {
        const char = dataString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      
      // Crear ID con formato recognizable (usando día para estabilidad)
      const envelopeId = `env-${Math.abs(hash).toString(16)}-${timeWindow.replace(/[:-]/g, '')}`;
      

      
      return envelopeId;
      
    } catch (error) {
      console.error(`[SENT_EMAIL_DEDUP] ❌ Error generando ID desde envelope:`, error);
      return null;
    }
  }

  /**
   * Extrae la dirección de email de un string que puede tener formato "Name <email>" o solo "email"
   */
  private static extractEmailAddress(emailString: string): string {
    if (!emailString || typeof emailString !== 'string') {
      return '';
    }
    
    const trimmed = emailString.trim();
    
    // Si tiene formato "Name <email@domain.com>", extraer solo el email
    const emailMatch = trimmed.match(/<([^>]+)>/);
    if (emailMatch) {
      return emailMatch[1].trim();
    }
    
    // Si no tiene <>, asumir que es solo el email
    return trimmed;
  }

  /**
   * Valida que un ID de email sea válido y suficientemente único
   */
  private static isValidEmailId(emailId: any): boolean {
    if (!emailId || typeof emailId !== 'string') {
      return false;
    }

    const trimmedId = emailId.trim();
    
    // Verificar longitud mínima más estricta
    if (trimmedId.length < 5) {
      return false;
    }
    
    // Verificar que no sea un ID demasiado genérico o común
    const genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
    if (genericIds.test(trimmedId)) {
      return false;
    }
    
    // Verificar que no sean solo números simples (1-999999) - UIDs de IMAP
    if (/^\d{1,6}$/.test(trimmedId)) {
      console.log(`[SENT_EMAIL_DEDUP] ❌ ID rechazado por ser UID numérico simple: "${trimmedId}"`);
      return false;
    }
    
    // Verificar que no sea solo letras simples (a, b, c, etc.)
    if (/^[a-zA-Z]{1,3}$/.test(trimmedId)) {
      return false;
    }
    
    // Preferir IDs que tengan formato de Message-ID (contienen @ o -)
    const hasMessageIdFormat = trimmedId.includes('@') || 
                              trimmedId.includes('-') || 
                              trimmedId.includes('.') ||
                              trimmedId.length > 10;
    
    if (!hasMessageIdFormat) {
      console.log(`[SENT_EMAIL_DEDUP] ⚠️ ID "${trimmedId}" no tiene formato de Message-ID esperado (sin @, -, . o muy corto)`);
      return false;
    }
    
    return true;
  }

  /**
   * Explica por qué un ID falló la validación (para debugging)
   */
  private static getValidationFailureReason(emailId: any): string {
    if (!emailId) return 'valor nulo o undefined';
    if (typeof emailId !== 'string') return 'no es string';
    
    const trimmedId = emailId.trim();
    if (trimmedId.length < 5) return 'muy corto (< 5 caracteres)';
    
    const genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
    if (genericIds.test(trimmedId)) return 'ID genérico/común';
    
    if (/^\d{1,6}$/.test(trimmedId)) return 'UID numérico simple (posible UID de IMAP)';
    if (/^[a-zA-Z]{1,3}$/.test(trimmedId)) return 'solo letras simples';
    
    const hasMessageIdFormat = trimmedId.includes('@') || 
                              trimmedId.includes('-') || 
                              trimmedId.includes('.') ||
                              trimmedId.length > 10;
    
    if (!hasMessageIdFormat) return 'sin formato de Message-ID esperado';
    
    return 'pasó todas las validaciones'; // No debería llegar aquí
  }

  /**
   * Filtra emails enviados para obtener solo los que NO han sido procesados
   * Esta es la función principal de deduplicación para emails enviados
   */
  static async filterUnprocessedSentEmails(
    emails: any[], 
    siteId: string
  ): Promise<{ unprocessed: any[], alreadyProcessed: any[], debugInfo: any[] }> {
    const unprocessed: any[] = [];
    const alreadyProcessed: any[] = [];
    const debugInfo: any[] = [];

    console.log(`[SENT_EMAIL_DEDUP] 🔍 Iniciando filtrado de ${emails.length} emails enviados para site: ${siteId}`);

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const debugItem: DebugItem = {
        index: i,
        emailTo: email.to,
        emailSubject: email.subject,
        emailDate: email.date,
        rawIds: {
          messageId: email.messageId,
          id: email.id,
          uid: email.uid
        }
      };



      // PASO 1: Extraer ID estándar
      const standardEmailId = this.extractStandardEmailId(email);
      debugItem.standardEmailId = standardEmailId;

      if (!standardEmailId) {
        console.log(`[SENT_EMAIL_DEDUP] ⚠️ Email sin ID válido, incluyendo en unprocessed`);
        debugItem.decision = 'unprocessed_no_id';
        debugInfo.push(debugItem);
        unprocessed.push(email);
        continue;
      }



      // PASO 2: Verificar en SyncedObjectsService si ya fue procesado
      try {
        const isProcessed = await SyncedObjectsService.objectIsProcessed(
          standardEmailId, 
          siteId, 
          'sent_email'
        );

        debugItem.existsInSyncedObjects = isProcessed;

        if (isProcessed) {

          debugItem.decision = 'already_processed_synced_objects';
          debugInfo.push(debugItem);
          alreadyProcessed.push(email);
          continue;
        } else {

        }

      } catch (error) {
        console.error(`[SENT_EMAIL_DEDUP] ❌ Error verificando en synced_objects para "${standardEmailId}":`, error);
        debugItem.syncedObjectsError = error instanceof Error ? error.message : String(error);
        // En caso de error, incluir en unprocessed para no bloquear
      }

      // PASO 3: Si no existe en synced_objects, crearlo como pendiente
      try {
        const created = await SyncedObjectsService.createObject({
          external_id: standardEmailId,
          site_id: siteId,
          object_type: 'sent_email',
          status: 'pending',
          provider: email.provider || 'unknown',
          metadata: {
            subject: email.subject,
            to: email.to,
            from: email.from,
            date: email.date,
            sync_source: 'sent_email_dedup_filter'
          }
        });

        if (created) {

          debugItem.decision = 'unprocessed_new';
          debugInfo.push(debugItem);
          unprocessed.push(email);
        } else {

          debugItem.decision = 'unprocessed_create_failed';
          debugInfo.push(debugItem);
          unprocessed.push(email);
        }

      } catch (error) {
        console.error(`[SENT_EMAIL_DEDUP] ❌ Error creando registro para "${standardEmailId}":`, error);
        debugItem.createError = error instanceof Error ? error.message : String(error);
        debugItem.decision = 'unprocessed_create_error';
        debugInfo.push(debugItem);
        unprocessed.push(email);
      }
    }

    const summary = {
      total: emails.length,
      unprocessed: unprocessed.length,
      alreadyProcessed: alreadyProcessed.length
    };

    console.log(`[SENT_EMAIL_DEDUP] 📊 RESUMEN DE FILTRADO:`, summary);
    console.log(`[SENT_EMAIL_DEDUP] ✅ Emails para procesar: ${unprocessed.length}`);
    console.log(`[SENT_EMAIL_DEDUP] 🔄 Emails ya procesados: ${alreadyProcessed.length}`);

    return { unprocessed, alreadyProcessed, debugInfo };
  }

  /**
   * Marca un email enviado como procesado exitosamente
   */
  static async markSentEmailAsProcessed(
    email: any,
    siteId: string,
    metadata: any = {}
  ): Promise<boolean> {
    const standardEmailId = this.extractStandardEmailId(email);
    
    if (!standardEmailId) {
      console.log(`[SENT_EMAIL_DEDUP] ⚠️ No se puede marcar como procesado, email sin ID válido`);
      return false;
    }



    try {
      const result = await SyncedObjectsService.updateObject(
        standardEmailId,
        siteId,
        {
          status: 'processed',
          metadata: {
            ...metadata,
            processed_at: new Date().toISOString(),
            sync_source: 'sent_email_processing'
          }
        },
        'sent_email'
      );

      if (result) {

        return true;
      } else {

        return false;
      }

    } catch (error) {
      console.error(`[SENT_EMAIL_DEDUP] ❌ Error marcando email "${standardEmailId}" como procesado:`, error);
      return false;
    }
  }

  /**
   * Marca un email enviado como error o saltado
   */
  static async markSentEmailAsError(
    email: any,
    siteId: string,
    errorMessage: string,
    isSkipped: boolean = false
  ): Promise<boolean> {
    const standardEmailId = this.extractStandardEmailId(email);
    
    if (!standardEmailId) {
      return false;
    }

    const status = isSkipped ? 'skipped' : 'error';


    try {
      const result = await SyncedObjectsService.updateObject(
        standardEmailId,
        siteId,
        {
          status,
          error_message: errorMessage,
          metadata: {
            error_at: new Date().toISOString(),
            sync_source: 'sent_email_processing'
          }
        },
        'sent_email'
      );

      return !!result;
    } catch (error) {
      console.error(`[SENT_EMAIL_DEDUP] ❌ Error marcando email "${standardEmailId}" como ${status}:`, error);
      return false;
    }
  }

  /**
   * Busca un mensaje existente por ID estándar en la base de datos
   */
  static async findExistingMessageByStandardId(
    conversationId: string,
    leadId: string,
    standardEmailId: string
  ): Promise<string | null> {
    if (!standardEmailId) return null;
    

    
    try {
      const searchQueries = [
        // Campo principal actual
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->>email_id', 'eq', standardEmailId)
          .limit(1),
        
        // Campo en delivery.details (formato actual)
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->delivery->>details->>api_messageId', 'eq', standardEmailId)
          .limit(1),
        
        // Campo legacy external_message_id
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->delivery->>external_message_id', 'eq', standardEmailId)
          .limit(1)
      ];
      
      // Ejecutar todas las búsquedas en paralelo
      const results = await Promise.allSettled(searchQueries);
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
          const foundMessageId = result.value.data[0].id;

          return foundMessageId;
        }
      }
      

      return null;
    } catch (error) {
      console.error('[SENT_EMAIL_DEDUP] Error buscando por ID estándar:', error);
      return null;
    }
  }

  /**
   * Verificación completa de duplicados para un email enviado
   */
  static async validateSentEmailForDuplication(
    email: any,
    conversationId: string,
    leadId: string
  ): Promise<EmailValidationResult> {
    const standardEmailId = this.extractStandardEmailId(email);
    
    // 1. Verificación por ID estándar (más rápida y confiable)
    if (standardEmailId) {
      const existingMessageId = await this.findExistingMessageByStandardId(
        conversationId, 
        leadId, 
        standardEmailId
      );
      
      if (existingMessageId) {
                 return {
           isDuplicate: true,
           reason: `Duplicado por ID estándar RFC 5322: "${standardEmailId}"`,
           existingId: existingMessageId,
           emailId: standardEmailId || undefined,
           standardId: standardEmailId || undefined
         };
      }
    }

    // 2. Verificación por fingerprint estable (fallback)
    try {
      const stableDuplicateCheck = await StableEmailDeduplicationService.isEmailDuplicateStable(
        email,
        conversationId,
        leadId
      );

      if (stableDuplicateCheck.isDuplicate) {
                 return {
           isDuplicate: true,
           reason: `Duplicado por fingerprint estable: ${stableDuplicateCheck.reason}`,
           existingId: stableDuplicateCheck.existingMessageId,
           emailId: standardEmailId || undefined,
           standardId: standardEmailId || undefined
         };
      }
    } catch (error) {
      console.warn('[SENT_EMAIL_DEDUP] Error en verificación por fingerprint estable:', error);
    }

         // 3. No es duplicado
     return {
       isDuplicate: false,
       emailId: standardEmailId || undefined,
       standardId: standardEmailId || undefined
     };
  }
} 