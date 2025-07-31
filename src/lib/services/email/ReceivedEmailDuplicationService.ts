/**
 * ReceivedEmailDuplicationService - Servicio especializado para detectar duplicados en emails RECIBIDOS
 * Usa el ID del email como base (más estable que timestamp para emails recibidos)
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

export class ReceivedEmailDuplicationService {
  
  /**
   * Genera envelope ID para emails RECIBIDOS usando el ID del correo como base principal
   */
  static generateReceivedEmailEnvelopeId(email: any): string | null {
    try {
      console.log(`[RECEIVED_EMAIL_DEDUP] 🏗️ Generando envelope ID para email recibido...`);
      
      // Extraer datos requeridos
      const to = email.to || email.recipient;
      const from = email.from || email.sender;
      const subject = email.subject;
      
      // PRIORIDAD 1: Usar ID del email (más estable que timestamp)
      const emailId = email.id || email.uid || email.messageId;
      
      if (!to || !from || !subject) {
        console.log(`[RECEIVED_EMAIL_DEDUP] ❌ Datos insuficientes para generar envelope ID:`, {
          hasTo: !!to,
          hasFrom: !!from, 
          hasSubject: !!subject,
          hasEmailId: !!emailId
        });
        return null;
      }
      
      // 🔧 NORMALIZAR CAMPOS - Extraer solo direcciones de email para consistencia
      const normalizedTo = this.extractEmailAddress(to).toLowerCase().trim();
      const normalizedFrom = this.extractEmailAddress(from).toLowerCase().trim();
      const normalizedSubject = subject.toLowerCase().trim().substring(0, 50); // Primeros 50 chars
      
      console.log(`[RECEIVED_EMAIL_DEDUP] 📊 Generando ID: ${normalizedFrom} → ${normalizedTo} (emailId: ${emailId})`);
      
      // Crear envelope ID estable usando TO + FROM + ID (escalable para múltiples bandejas)
      const dataString = `${normalizedTo}|${normalizedFrom}|${emailId || 'no-id'}`;
      
      // Generar hash estable y determinístico
      let hash = 0;
      for (let i = 0; i < dataString.length; i++) {
        const char = dataString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      
      // Crear ID con formato recognizable: recv-{hash}-{emailId_truncado}
      const emailIdSuffix = emailId ? String(emailId).replace(/[^a-zA-Z0-9]/g, '').substring(0, 8) : 'noid';
      const envelopeId = `recv-${Math.abs(hash).toString(16)}-${emailIdSuffix}`;
      
      console.log(`[RECEIVED_EMAIL_DEDUP] ✅ Envelope ID generado: "${envelopeId}"`);
      console.log(`[RECEIVED_EMAIL_DEDUP] 📊 Base: "${dataString}"`);
      
      return envelopeId;
      
    } catch (error) {
      console.error(`[RECEIVED_EMAIL_DEDUP] ❌ Error generando envelope ID:`, error);
      return null;
    }
  }

  /**
   * Extrae dirección de email limpia desde un campo que puede tener formato "Name <email@domain.com>"
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
    
    // Fallback: retornar el campo limpio
    return emailField.trim();
  }

  /**
   * Filtra emails recibidos ya procesados usando envelope IDs basados en email ID
   */
  static async filterUnprocessedReceivedEmails(
    emails: any[], 
    siteId: string
  ): Promise<{ unprocessed: any[], alreadyProcessed: any[], debugInfo: any[] }> {
    console.log(`[RECEIVED_EMAIL_DEDUP] 🔄 Filtrando ${emails.length} emails recibidos ya procesados...`);
    
    const unprocessed: any[] = [];
    const alreadyProcessed: any[] = [];
    const debugInfo: any[] = [];
    
    // Generar envelope IDs para todos los emails
    const emailsWithEnvelopes = emails.map(email => ({
      ...email,
      envelopeId: this.generateReceivedEmailEnvelopeId(email)
    })).filter(email => email.envelopeId); // Solo emails con envelope ID válido
    
    if (emailsWithEnvelopes.length === 0) {
      console.log(`[RECEIVED_EMAIL_DEDUP] ⚠️ Ningún email pudo generar envelope ID válido`);
      return { unprocessed: [], alreadyProcessed: [], debugInfo: [] };
    }
    
    // Obtener envelope IDs ya procesados
    const envelopeIds = emailsWithEnvelopes.map(email => email.envelopeId);
    
    try {
      const { data: existingObjects, error } = await supabaseAdmin
        .from('synced_objects')
        .select('external_id')
        .eq('site_id', siteId)
        .eq('object_type', 'email')
        .in('external_id', envelopeIds);
      
      if (error) {
        console.warn(`[RECEIVED_EMAIL_DEDUP] ⚠️ Error consultando synced_objects:`, error);
        // En caso de error, procesar todos los emails
        return { 
          unprocessed: emails, 
          alreadyProcessed: [], 
          debugInfo: emails.map((email, index) => ({
            index: index + 1,
            emailTo: email.to,
            envelopeId: emailsWithEnvelopes.find(e => e.id === email.id)?.envelopeId || 'N/A',
            decision: 'ERROR_DB - procesado por seguridad'
          }))
        };
      }
      
      const processedEnvelopeIds = new Set(existingObjects?.map(obj => obj.external_id) || []);
      console.log(`[RECEIVED_EMAIL_DEDUP] 🔍 ${processedEnvelopeIds.size} emails ya procesados encontrados`);
      
      // Separar emails procesados vs no procesados
      for (const email of emailsWithEnvelopes) {
        const isProcessed = processedEnvelopeIds.has(email.envelopeId);
        
        debugInfo.push({
          index: debugInfo.length + 1,
          emailTo: email.to,
          emailFrom: email.from,
          emailSubject: email.subject,
          envelopeId: email.envelopeId,
          decision: isProcessed ? 'YA_PROCESADO - omitido' : 'NUEVO - procesado'
        });
        
        if (isProcessed) {
          console.log(`[RECEIVED_EMAIL_DEDUP] 🚫 Email ya procesado: ${email.from} → ${email.to} (ID: ${email.envelopeId})`);
          alreadyProcessed.push(email);
        } else {
          console.log(`[RECEIVED_EMAIL_DEDUP] ✅ Email nuevo: ${email.from} → ${email.to} (ID: ${email.envelopeId})`);
          unprocessed.push(email);
        }
      }
      
      console.log(`[RECEIVED_EMAIL_DEDUP] 📈 RESUMEN: ${unprocessed.length} nuevos, ${alreadyProcessed.length} ya procesados`);
      
      return { unprocessed, alreadyProcessed, debugInfo };
      
    } catch (error) {
      console.error(`[RECEIVED_EMAIL_DEDUP] ❌ Error en filtrado:`, error);
      // En caso de error, procesar todos por seguridad
      return { 
        unprocessed: emails, 
        alreadyProcessed: [], 
        debugInfo: emails.map((email, index) => ({
          index: index + 1,
          emailTo: email.to,
          envelopeId: 'ERROR',
          decision: 'ERROR_GENERAL - procesado por seguridad'
        }))
      };
    }
  }
}