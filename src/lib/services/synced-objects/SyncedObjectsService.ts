/**
 * SyncedObjectsService - Maneja el tracking de objetos procesados para evitar duplicaciones
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SentEmailDuplicationService } from '@/lib/services/email/SentEmailDuplicationService';

export interface SyncedObject {
  id: string;
  external_id: string;
  site_id: string;
  object_type: string;
  status: string;
  provider?: string;
  first_seen_at: string;
  last_processed_at?: string;
  process_count: number;
  metadata: Record<string, any>;
  error_message?: string;
  claim_token?: string | null;
  claim_expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSyncedObjectInput {
  external_id: string;
  site_id: string;
  object_type?: string;
  status?: string;
  provider?: string;
  metadata?: Record<string, any>;
}

export interface UpdateSyncedObjectInput {
  status?: string;
  metadata?: Record<string, any>;
  error_message?: string;
}

export class SyncedObjectsService {
  private static readonly DEFAULT_OBJECT_TYPE = 'email';
  private static readonly DEFAULT_STATUS = 'pending';

  /**
   * Valida que un ID de email sea válido y suficientemente único
   */
  private static isValidEmailId(emailId: any): boolean {
    // Verificar que sea string válido
    if (!emailId || typeof emailId !== 'string') {
      return false;
    }

    const trimmedId = emailId.trim();
    
    // Verificar longitud mínima
    if (trimmedId.length < 3) {
      return false;
    }
    
    // Verificar que no sea un ID demasiado genérico o común
    const genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
    if (genericIds.test(trimmedId)) {
      return false;
    }
    
    // Verificar que no sean solo números simples (1-100)
    if (/^\d{1,2}$/.test(trimmedId) && parseInt(trimmedId) <= 100) {
      return false;
    }
    
    return true;
  }

  /**
   * Extrae y valida el ID más confiable de un email siguiendo RFC 5322
   * DEBE SER IDÉNTICO al extractValidEmailId del email sync route
   */
  private static extractValidEmailId(email: any): string | null {
    // 🎯 USAR LA MISMA LÓGICA QUE sendEmail PARA CONSISTENCIA
    // Priorizar Message-ID para correlación perfecta (RFC 5322)
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
        return candidate.trim();
      }
    }
    
    return null;
  }

  /**
   * Genera un envelope ID consistente usando la misma lógica que sendEmail
   * DEBE SER IDÉNTICO al generateEnvelopeBasedId de SentEmailDuplicationService
   */
  private static generateConsistentEnvelopeId(email: any): string | null {
    try {
      // Usar exactamente la misma lógica que sendEmail
      return SentEmailDuplicationService.generateEnvelopeBasedId(email);
    } catch (error) {
      console.error(`[SYNCED_OBJECTS] ❌ Error generando envelope ID consistente:`, error);
      return null;
    }
  }

  /**
   * Verifica si un objeto ya existe en la base de datos
   */
  static async objectExists(
    externalId: string, 
    siteId: string, 
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('synced_objects')
        .select('id')
        .eq('external_id', externalId)
        .eq('site_id', siteId)
        .eq('object_type', objectType)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = No rows found
        throw error;
      }

      return !!data;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error checking object existence:', error);
      return false; // En caso de error, asumir que no existe para no bloquear el proceso
    }
  }

  /**
   * Verifica si un objeto ya fue procesado (status 'processed' o 'replied')
   */
  static async objectIsProcessed(
    externalId: string, 
    siteId: string, 
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('synced_objects')
        .select('status')
        .eq('external_id', externalId)
        .eq('site_id', siteId)
        .eq('object_type', objectType)
        .in('status', ['processed', 'replied'])
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = No rows found
        throw error;
      }

      return !!data; // Solo true si existe Y tiene status processed/replied
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error checking if object is processed:', error);
      return false; // En caso de error, asumir que no está procesado para no bloquear el proceso
    }
  }

  /**
   * Obtiene un objeto sincronizado por ID externo
   */
  static async getObject(
    externalId: string, 
    siteId: string, 
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<SyncedObject | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('synced_objects')
        .select('*')
        .eq('external_id', externalId)
        .eq('site_id', siteId)
        .eq('object_type', objectType)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null;
        }
        throw error;
      }

      return data as SyncedObject;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error getting object:', error);
      return null;
    }
  }

  /**
   * Crea un nuevo objeto sincronizado
   */
  static async createObject(input: CreateSyncedObjectInput): Promise<SyncedObject | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('synced_objects')
        .insert({
          external_id: input.external_id,
          site_id: input.site_id,
          object_type: input.object_type || this.DEFAULT_OBJECT_TYPE,
          status: input.status || this.DEFAULT_STATUS,
          provider: input.provider,
          metadata: input.metadata || {},
          first_seen_at: new Date().toISOString(),
          process_count: 0
        })
        .select()
        .single();

      if (error) {
        // Si es un error de duplicado, intentar obtener el objeto existente
        if (error.code === '23505') { // Unique constraint violation
          console.log(`[SYNCED_OBJECTS] Object already exists: ${input.external_id}`);
          return await this.getObject(input.external_id, input.site_id, input.object_type);
        }
        throw error;
      }

      console.log(`[SYNCED_OBJECTS] ✅ Object created: ${input.external_id}`);
      return data as SyncedObject;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error creating object:', error);
      return null;
    }
  }

  static async claimObjectsBatch(
    inputs: CreateSyncedObjectInput[],
    siteId: string,
    objectType: string = this.DEFAULT_OBJECT_TYPE,
  ): Promise<Map<string, string>> {
    if (inputs.length === 0) return new Map();
    const { data, error } = await supabaseAdmin.rpc(
      'claim_synced_objects_batch',
      {
        p_site_id: siteId,
        p_object_type: objectType,
        p_objects: inputs.map((input) => ({
          external_id: input.external_id,
          provider: input.provider,
          metadata: input.metadata || {},
        })),
      },
    );
    if (error) {
      throw new Error(`Batch claim failed: ${error.message}`);
    }
    return new Map(
      (data || []).map((row: {
        external_id: string;
        claimed_token: string;
      }) => [
        row.external_id,
        row.claimed_token,
      ]),
    );
  }

  /**
   * Actualiza un objeto sincronizado
   */
  static async updateObject(
    externalId: string, 
    siteId: string, 
    updates: UpdateSyncedObjectInput,
    objectType: string = this.DEFAULT_OBJECT_TYPE,
    claimToken?: string,
  ): Promise<SyncedObject | null> {
    try {
      const updateData: any = {
        ...updates,
        last_processed_at: new Date().toISOString()
      };

      // Si se está actualizando el status, incrementar process_count
      if (updates.status) {
        updateData.claim_token = null;
        updateData.claim_expires_at = null;
        const { data: currentData } = await supabaseAdmin
          .from('synced_objects')
          .select('process_count')
          .eq('external_id', externalId)
          .eq('site_id', siteId)
          .eq('object_type', objectType)
          .single();

        if (currentData) {
          updateData.process_count = (currentData.process_count || 0) + 1;
        }
      }

      let updateQuery = supabaseAdmin
        .from('synced_objects')
        .update(updateData)
        .eq('external_id', externalId)
        .eq('site_id', siteId)
        .eq('object_type', objectType);
      if (claimToken) {
        updateQuery = updateQuery.eq('claim_token', claimToken);
      }
      const { data, error } = await updateQuery
        .select()
        .single();

      if (error) {
        throw error;
      }

      console.log(`[SYNCED_OBJECTS] ✅ Object updated: ${externalId} -> ${updates.status || 'metadata updated'}`);
      return data as SyncedObject;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error updating object:', error);
      return null;
    }
  }

  /**
   * Marca un objeto como procesado
   */
  static async markAsProcessed(
    externalId: string, 
    siteId: string, 
    metadata?: Record<string, any>,
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<boolean> {
    try {
      const result = await this.updateObject(externalId, siteId, {
        status: 'processed',
        metadata: metadata
      }, objectType);

      return !!result;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error marking as processed:', error);
      return false;
    }
  }

  /**
   * Marca un objeto como respondido
   */
  static async markAsReplied(
    externalId: string, 
    siteId: string, 
    metadata?: Record<string, any>,
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<boolean> {
    try {
      const result = await this.updateObject(externalId, siteId, {
        status: 'replied',
        metadata: metadata
      }, objectType);

      return !!result;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error marking as replied:', error);
      return false;
    }
  }

  /**
   * Filtra emails que no han sido procesados previamente
   */
  static async filterUnprocessedEmails(
    emails: any[], 
    siteId: string,
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<{ unprocessed: any[], alreadyProcessed: any[] }> {
    const unprocessed: any[] = [];
    const alreadyProcessed: any[] = [];
    const validEmails = emails.flatMap((email) => {
      const externalId = this.extractValidEmailId(email);
      if (!externalId) {
        unprocessed.push(email);
        return [];
      }
      return [{ email, externalId }];
    });
    const seenIds = new Set<string>();
    const uniqueEmails = validEmails.filter(({ email, externalId }) => {
      if (seenIds.has(externalId)) {
        alreadyProcessed.push(email);
        return false;
      }
      seenIds.add(externalId);
      return true;
    });
    const statuses = await this.claimObjectsBatch(
      uniqueEmails.map(({ email, externalId }) => ({
        external_id: externalId,
        site_id: siteId,
        object_type: objectType,
        provider: email.provider || 'unknown',
        metadata: {
          subject: email.subject,
          from: email.from,
          to: email.to,
          date: email.date || email.received_date,
        },
      })),
      siteId,
      objectType,
    );

    for (const { email, externalId } of uniqueEmails) {
      if (statuses.has(externalId)) {
        unprocessed.push({
          ...email,
          _sync_claim_token: statuses.get(externalId),
        });
      } else {
        alreadyProcessed.push(email);
      }
    }

    console.log(`[SYNCED_OBJECTS] 📊 Filter results: ${unprocessed.length} unprocessed, ${alreadyProcessed.length} already processed`);
    
    return { unprocessed, alreadyProcessed };
  }

  /**
   * Obtiene estadísticas de objetos procesados para un sitio
   */
  static async getProcessingStats(
    siteId: string,
    objectType: string = this.DEFAULT_OBJECT_TYPE
  ): Promise<{
    total: number;
    pending: number;
    processing: number;
    processed: number;
    replied: number;
    error: number;
  }> {
    try {
      const { data, error } = await supabaseAdmin
        .from('synced_objects')
        .select('status')
        .eq('site_id', siteId)
        .eq('object_type', objectType);

      if (error) {
        throw error;
      }

      const stats = {
        total: data.length,
        pending: 0,
        processing: 0,
        processed: 0,
        replied: 0,
        error: 0
      };

      data.forEach(item => {
        const status = item.status as keyof typeof stats;
        if (status in stats) {
          stats[status]++;
        }
      });

      return stats;
    } catch (error) {
      console.error('[SYNCED_OBJECTS] Error getting stats:', error);
      return {
        total: 0,
        pending: 0,
        processing: 0,
        processed: 0,
        replied: 0,
        error: 0
      };
    }
  }
} 