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
    const candidates = [
      email.messageId, // 🎯 PRIORIZAR Message-ID para correlación perfecta (RFC 5322)
      email.id,
      email.uid,
      email.message_id,
      email.Message_ID,
      email.ID
    ];
    
    for (const candidate of candidates) {
      if (this.isValidEmailId(candidate)) {
        const standardId = candidate.trim();
        console.log(`[SENT_EMAIL_DEDUP] 🆔 ID estándar extraído: "${standardId}" (fuente: ${candidates.indexOf(candidate) === 0 ? 'messageId' : 'fallback'})`);
        return standardId;
      }
    }
    
    console.log(`[SENT_EMAIL_DEDUP] ⚠️ No se pudo extraer un ID estándar válido del email`);
    console.log(`[SENT_EMAIL_DEDUP] 🔍 Candidatos evaluados:`, candidates.map((c, i) => `${i}: ${c} (válido: ${this.isValidEmailId(c)})`));
    return null;
  }

  /**
   * Valida que un ID de email sea válido y suficientemente único
   */
  private static isValidEmailId(emailId: any): boolean {
    if (!emailId || typeof emailId !== 'string') {
      return false;
    }

    const trimmedId = emailId.trim();
    
    if (trimmedId.length < 3) {
      return false;
    }
    
    const genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
    if (genericIds.test(trimmedId)) {
      return false;
    }
    
    if (/^\d{1,2}$/.test(trimmedId) && parseInt(trimmedId) <= 100) {
      return false;
    }
    
    return true;
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

      console.log(`[SENT_EMAIL_DEDUP] 📧 [${i+1}/${emails.length}] Procesando email enviado a: ${email.to}`);
      console.log(`[SENT_EMAIL_DEDUP] 📧 Subject: "${email.subject}"`);
      console.log(`[SENT_EMAIL_DEDUP] 📧 Date: ${email.date}`);

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

      console.log(`[SENT_EMAIL_DEDUP] 🆔 ID estándar para verificación: "${standardEmailId}"`);

      // PASO 2: Verificar en SyncedObjectsService si ya fue procesado
      try {
        const exists = await SyncedObjectsService.objectExists(
          standardEmailId, 
          siteId, 
          'sent_email'
        );

        debugItem.existsInSyncedObjects = exists;

        if (exists) {
          console.log(`[SENT_EMAIL_DEDUP] ✅ Email "${standardEmailId}" YA PROCESADO en synced_objects, SALTANDO`);
          debugItem.decision = 'already_processed_synced_objects';
          debugInfo.push(debugItem);
          alreadyProcessed.push(email);
          continue;
        } else {
          console.log(`[SENT_EMAIL_DEDUP] 🆕 Email "${standardEmailId}" NO encontrado en synced_objects, PROCESANDO`);
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
          console.log(`[SENT_EMAIL_DEDUP] ✅ Email "${standardEmailId}" registrado como pendiente, PROCESANDO`);
          debugItem.decision = 'unprocessed_new';
          debugInfo.push(debugItem);
          unprocessed.push(email);
        } else {
          console.log(`[SENT_EMAIL_DEDUP] ⚠️ No se pudo crear registro para "${standardEmailId}", PROCESANDO de todas formas`);
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

    console.log(`[SENT_EMAIL_DEDUP] ✅ Marcando email "${standardEmailId}" como PROCESADO`);

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
        console.log(`[SENT_EMAIL_DEDUP] ✅ Email "${standardEmailId}" marcado como procesado exitosamente`);
        return true;
      } else {
        console.log(`[SENT_EMAIL_DEDUP] ❌ No se pudo marcar email "${standardEmailId}" como procesado`);
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
    console.log(`[SENT_EMAIL_DEDUP] ❌ Marcando email "${standardEmailId}" como ${status}: ${errorMessage}`);

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
    
    console.log(`[SENT_EMAIL_DEDUP] 🔍 Buscando mensaje existente con ID estándar: "${standardEmailId}"`);
    
    try {
      const searchQueries = [
        // Campo principal actual
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->email_id', 'eq', standardEmailId)
          .limit(1),
        
        // Campo en delivery.details (formato actual)
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->delivery->details->api_messageId', 'eq', standardEmailId)
          .limit(1),
        
        // Campo legacy external_message_id
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->delivery->external_message_id', 'eq', standardEmailId)
          .limit(1)
      ];
      
      // Ejecutar todas las búsquedas en paralelo
      const results = await Promise.allSettled(searchQueries);
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
          const foundMessageId = result.value.data[0].id;
          console.log(`[SENT_EMAIL_DEDUP] ✅ DUPLICADO ENCONTRADO por ID estándar "${standardEmailId}": ${foundMessageId}`);
          return foundMessageId;
        }
      }
      
      console.log(`[SENT_EMAIL_DEDUP] ✅ No hay duplicados con ID estándar: "${standardEmailId}"`);
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