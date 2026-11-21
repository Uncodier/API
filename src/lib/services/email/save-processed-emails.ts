import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ReceivedEmailDuplicationService } from './ReceivedEmailDuplicationService';
import { TextHashService } from '../../utils/text-hash-service';

export async function saveProcessedEmails(
  emailsToSave: any[],
  validEmails: any[],
  emailToEnvelopeMap: Map<any, string>,
  siteId: string,
  effectiveDbUuid?: string,
  internalCommandId?: string,
  effectiveAgentId?: string
): Promise<void> {
  console.log(`[EMAIL_PROCESSING] 💾 ========== INICIANDO GUARDADO DE EMAILS ==========`);
  console.log(`[EMAIL_PROCESSING] 📊 Emails a guardar: ${emailsToSave.length}`);
  console.log(`[EMAIL_PROCESSING] 📊 Valid emails disponibles para búsqueda: ${validEmails.length}`);
  console.log(`[EMAIL_PROCESSING] 📊 EmailToEnvelopeMap size: ${emailToEnvelopeMap.size}`);
  console.log(`[EMAIL_PROCESSING] 📊 Site ID: ${siteId}`);

  if (emailsToSave.length === 0) {
    console.log(`[EMAIL_PROCESSING] ⚠️ No hay emails para guardar, finalizando...`);
    return;
  }

  // Log sample of emails to save for debugging
  console.log(`[EMAIL_PROCESSING] 🔍 Muestra de emails a guardar (primeros 3):`);
  emailsToSave.slice(0, 3).forEach((email, idx) => {
    console.log(`[EMAIL_PROCESSING]   ${idx + 1}. analysis_id: ${email.analysis_id || email.id}, isAlias: ${email.isAlias}, isAILead: ${email.isAILead}, contact: ${email.contact_info?.email}`);
  });

  const processedEmailsWithEnvelopes = emailsToSave.map((emailObj, index) => {
    const emailId = emailObj.email ? emailObj.email.id : (emailObj.analysis_id || emailObj.id);
    console.log(`[EMAIL_PROCESSING] 🔍 [${index + 1}/${emailsToSave.length}] Buscando email original con ID: ${emailId}`);

    // Try to find original email using multiple strategies
    let originalEmail = validEmails.find(ve =>
      ve.id === emailId ||
      ve.messageId === emailId ||
      ve.uid === emailId ||
      String(ve.id) === String(emailId) ||
      String(ve.messageId) === String(emailId) ||
      String(ve.uid) === String(emailId)
    ) || null;

    // If not found, try to find by matching contact info email
    if (!originalEmail && emailObj.contact_info?.email) {
      const contactEmail = emailObj.contact_info.email.toLowerCase();
      originalEmail = validEmails.find(ve => {
        const veFrom = (ve.from || '').toLowerCase();
        const veReplyTo = (ve.replyTo || '').toLowerCase();
        return veFrom.includes(contactEmail) || veReplyTo.includes(contactEmail);
      }) || null;

      if (originalEmail) {
        console.log(`[EMAIL_PROCESSING] ✅ Email original encontrado por contacto: ${contactEmail}`);
      }
    }

    // Get envelopeId from map if originalEmail found
    let envelopeId = originalEmail ? emailToEnvelopeMap.get(originalEmail) : null;

    // Fallback: Generate envelopeId if not found but we have email data
    if (!envelopeId) {
      if (originalEmail) {
        // Try to generate envelopeId from originalEmail
        envelopeId = ReceivedEmailDuplicationService.generateReceivedEmailEnvelopeId(originalEmail);
        if (envelopeId) {
          console.log(`[EMAIL_PROCESSING] 🔧 EnvelopeId generado desde originalEmail: ${envelopeId}`);
        }
      } else if (emailObj.contact_info?.email && emailObj.original_subject) {
        // Try to find 'to' from validEmails by matching contact email
        let fallbackTo = null;
        const contactEmail = emailObj.contact_info.email.toLowerCase();
        const matchingEmail = validEmails.find(ve => {
          const veFrom = (ve.from || '').toLowerCase();
          return veFrom.includes(contactEmail);
        });
        if (matchingEmail?.to) {
          fallbackTo = matchingEmail.to;
        }

        // Try to generate from emailObj data as last resort
        // Note: generateReceivedEmailEnvelopeId requires 'to', so we use a placeholder if not found
        const fallbackEmail = {
          from: emailObj.contact_info.email,
          to: fallbackTo || 'unknown@alias', // Placeholder if we can't find the actual 'to'
          subject: emailObj.original_subject,
          id: emailId,
          messageId: emailId,
          uid: emailId
        };
        envelopeId = ReceivedEmailDuplicationService.generateReceivedEmailEnvelopeId(fallbackEmail);
        if (envelopeId) {
          console.log(`[EMAIL_PROCESSING] 🔧 EnvelopeId generado desde emailObj (fallback): ${envelopeId}`);
          if (!fallbackTo) {
            console.warn(`[EMAIL_PROCESSING] ⚠️ Usando 'to' placeholder para generación de envelopeId`);
          }
        }
      }

      if (!originalEmail) {
        console.warn(`[EMAIL_PROCESSING] ⚠️ Email original NO encontrado para ID: ${emailId}`);
        console.warn(`[EMAIL_PROCESSING] ⚠️   - analysis_id: ${emailObj.analysis_id}`);
        console.warn(`[EMAIL_PROCESSING] ⚠️   - contact_info.email: ${emailObj.contact_info?.email}`);
        console.warn(`[EMAIL_PROCESSING] ⚠️   - original_subject: ${emailObj.original_subject}`);
      }
    } else {
      console.log(`[EMAIL_PROCESSING] ✅ EnvelopeId encontrado en map: ${envelopeId}`);
    }

    const rawTextForHash = (() => {
      try {
        const subject = originalEmail?.subject || emailObj.original_subject || '';
        const body = originalEmail?.body || emailObj.original_text || '';
        const from = originalEmail?.from || emailObj.contact_info?.email || '';
        const to = originalEmail?.to || '';
        const date = originalEmail?.date || originalEmail?.received_date || '';
        return `${from}\n${to}\n${subject}\n${date}\n\n${body}`;
      } catch {
        return '';
      }
    })();
    const hashForDb = TextHashService.hash64String(rawTextForHash);

    return { email: emailObj, originalEmail: originalEmail || {} as any, envelopeId, contentHash: hashForDb };
  });

  // Filter: Keep items that have envelopeId OR valid contentHash
  const beforeFilter = processedEmailsWithEnvelopes.length;
  const filtered = processedEmailsWithEnvelopes.filter(item => {
    if (item.envelopeId) {
      console.log(`[EMAIL_PROCESSING] ✅ Email incluido (tiene envelopeId): ${item.envelopeId}`);
      return true;
    }
    const t = typeof item.contentHash;
    if (t === 'bigint' || t === 'number') {
      console.log(`[EMAIL_PROCESSING] ✅ Email incluido (tiene contentHash numérico): ${item.contentHash}`);
      return true;
    }
    if (t === 'string' && (item.contentHash as unknown as string).length > 0) {
      console.log(`[EMAIL_PROCESSING] ✅ Email incluido (tiene contentHash string): ${item.contentHash}`);
      return true;
    }
    console.warn(`[EMAIL_PROCESSING] 🚫 Email EXCLUIDO (sin envelopeId ni contentHash válido)`);
    return false;
  });

  if (beforeFilter !== filtered.length) {
    console.warn(`[EMAIL_PROCESSING] ⚠️ ${beforeFilter - filtered.length} emails filtrados (sin envelopeId ni hash válido)`);
  }

  const finalProcessedEmails = filtered;

  if (finalProcessedEmails.length > 0) {
    try {
      const syncedObjectsToInsert = finalProcessedEmails.map(({ email, originalEmail, envelopeId, contentHash }) => {
        // Use envelopeId as external_id if available, otherwise use hash as fallback
        // Format hash-based external_id to distinguish from envelope-based ones
        const externalId = envelopeId || (contentHash ? `hash-${String(contentHash)}` : null);

        if (!externalId) {
          console.error(`[EMAIL_PROCESSING] ❌ No se puede guardar email: sin envelopeId ni contentHash`);
          return null;
        }

        return {
          external_id: externalId,
        site_id: siteId,
        object_type: 'email',
        status: 'processed',
        provider: originalEmail?.provider || 'unknown',
        hash: (contentHash !== null && contentHash !== undefined) ? String(contentHash) : null,
        metadata: {
            subject: originalEmail?.subject || email.original_subject,
            from: originalEmail?.from || email.contact_info?.email,
          to: originalEmail?.to,
          date: originalEmail?.date || originalEmail?.received_date,
          command_id: (email.isAlias || email.isAILead) ? null : (effectiveDbUuid || internalCommandId),
          analysis_timestamp: new Date().toISOString(),
          agent_id: (email.isAlias || email.isAILead) ? null : effectiveAgentId,
          envelope_id: envelopeId,
            has_fallback_id: !envelopeId, // Flag to indicate we used hash as fallback
          source: email.isAlias ? 'alias_direct_response' :
                 email.isAILead ? 'ai_lead_direct_response' : 'email_analysis',
          processing_type: email.isAlias ? 'alias_direct' :
                          email.isAILead ? 'ai_lead_direct' : 'agent_analysis'
        },
        first_seen_at: new Date().toISOString(),
        last_processed_at: new Date().toISOString(),
        process_count: 1
        };
      }).filter(Boolean); // Remove any null entries

      const { error } = await supabaseAdmin
        .from('synced_objects')
        .upsert(syncedObjectsToInsert, {
          onConflict: 'external_id,site_id,object_type'
        });

      if (error) {
        console.error(`[EMAIL_PROCESSING] ❌ Error en upsert de emails procesados:`, error);
        console.error(`[EMAIL_PROCESSING] ❌ Detalles del error:`, JSON.stringify(error, null, 2));
        console.error(`[EMAIL_PROCESSING] ❌ Intentando guardar ${syncedObjectsToInsert.length} objetos`);
      } else {
        const withEnvelopeId = finalProcessedEmails.filter(e => e.envelopeId).length;
        const withHashOnly = finalProcessedEmails.filter(e => !e.envelopeId && e.contentHash).length;
        const withFallbackId = syncedObjectsToInsert.filter((obj: any) => obj?.metadata?.has_fallback_id).length;

        console.log(`[EMAIL_PROCESSING] ✅ ========== GUARDADO EXITOSO ==========`);
        console.log(`[EMAIL_PROCESSING] ✅ Total guardados en synced_objects: ${syncedObjectsToInsert.length} emails`);
        console.log(`[EMAIL_PROCESSING] 📊 Desglose:`);
        console.log(`[EMAIL_PROCESSING]   - Con envelopeId: ${withEnvelopeId}`);
        console.log(`[EMAIL_PROCESSING]   - Con hash solamente: ${withHashOnly}`);
        console.log(`[EMAIL_PROCESSING]   - Usando ID de fallback (hash): ${withFallbackId}`);
      }
    } catch (error) {
      console.error(`[EMAIL_PROCESSING] ❌ Error crítico en guardado de emails:`, error);
      console.error(`[EMAIL_PROCESSING] ❌ Stack trace:`, error instanceof Error ? error.stack : 'N/A');
    }
  } else {
    console.warn(`[EMAIL_PROCESSING] ⚠️ No hay emails válidos para guardar después del filtrado`);
    console.warn(`[EMAIL_PROCESSING] ⚠️ Emails procesados inicialmente: ${beforeFilter}, Emails después del filtro: ${filtered.length}`);
  }

  console.log(`[EMAIL_PROCESSING] 💾 ========== FINALIZADO GUARDADO DE EMAILS ==========`);
}
