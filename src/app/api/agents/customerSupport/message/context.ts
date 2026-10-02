import { ConversationService } from '@/lib/services/conversation-service';
import { getLeadInfo, isValidUUID } from './agent-data';
import { appendLeadRecordToContext } from '@/app/api/agents/customerSupport/lead-record';
import { appendActivePromotionsToContext } from '@/lib/promotions/context';
import { getCompletedChannelMessageGuidance } from '@/lib/services/workflow-robot/channel-message';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { getCustomerSupportPolicies } from '@/app/api/agents/customerSupport/support-policies';
export async function buildSupportContext(input: any) {
const { request, message, name, email, phone, requestTimestamp, clientIP, userAgent, acceptLanguage, effectiveOrigin, effectiveLeadId, effectiveConversationId, effectiveSiteId, origin_message_id, channel_guidance_run_plan_ids, website_chat_origin } = input;
    // Retrieve conversation history if a conversation ID is provided
    let contextMessage = `${message}`;
    
    // Agregar información del request al contexto
    contextMessage += `\n\nRequest Information:`;
    contextMessage += `\nTimestamp: ${requestTimestamp}`;
    contextMessage += `\nClient IP: ${clientIP}`;
    contextMessage += `\nUser Agent: ${userAgent}`;
    contextMessage += `\nLanguage: ${acceptLanguage}`;
    if (effectiveOrigin) {
      contextMessage += `\nChannel: ${effectiveOrigin}`;
    }
    
    // Obtener y añadir información completa del lead al contexto si está disponible
    if (effectiveLeadId) {
      console.log(`📋 Obteniendo información completa del lead para el contexto: ${effectiveLeadId}`);
      const leadInfo = await getLeadInfo(effectiveLeadId);
      
      if (leadInfo) {
        contextMessage += "\n\nLead Information:";
        contextMessage += `\nLead ID: ${leadInfo.id}`;
        contextMessage += `\nName: ${leadInfo.name || 'N/A'}`;
        contextMessage += `\nEmail: ${leadInfo.email || 'N/A'}`;
        contextMessage += `\nPhone: ${leadInfo.phone || 'N/A'}`;
        
        // Manejar el campo company correctamente
        let companyDisplay = 'N/A';
        if (leadInfo.company) {
          if (typeof leadInfo.company === 'string') {
            companyDisplay = leadInfo.company;
          } else if (typeof leadInfo.company === 'object' && leadInfo.company.name) {
            companyDisplay = leadInfo.company.name;
          } else if (typeof leadInfo.company === 'object') {
            // Verificar si el objeto está vacío
            const objectKeys = Object.keys(leadInfo.company);
            if (objectKeys.length === 0) {
              companyDisplay = 'N/A';
            } else {
              // Si es un objeto sin campo name, intentar otros campos comunes
              companyDisplay = leadInfo.company.company_name || 
                             leadInfo.company.businessName || 
                             leadInfo.company.title || 
                             leadInfo.company.organization || 
                             leadInfo.company.business_name;
              
              // Si no se encontró ningún campo válido, usar N/A
              if (!companyDisplay) {
                companyDisplay = 'N/A';
              }
            }
          }
        }
        contextMessage += `\nCompany: ${companyDisplay}`;
        
        contextMessage += `\nStatus: ${leadInfo.status || 'N/A'}`;
        contextMessage += `\nOrigin: ${leadInfo.origin || 'N/A'}`;
        contextMessage += `\nLead Score: ${leadInfo.lead_score || 'N/A'}`;
        contextMessage += `\nSource: ${leadInfo.source || 'N/A'}`;
        
        // Agregar información adicional si está disponible
        if (leadInfo.contact_info) {
          try {
            const contactInfo = typeof leadInfo.contact_info === 'string' 
              ? JSON.parse(leadInfo.contact_info) 
              : leadInfo.contact_info;
            if (contactInfo && Object.keys(contactInfo).length > 0) {
              contextMessage += `\nAdditional Contact Info: ${JSON.stringify(contactInfo)}`;
            }
          } catch (e) {
            console.log('⚠️ Error parsing contact_info for context');
          }
        }
        
        if (leadInfo.notes) {
          contextMessage += `\nNotes: ${leadInfo.notes}`;
        }
        
        console.log(`✅ Información completa del lead agregada al contexto`);
      } else {
        // Si no pudimos obtener la información completa del lead, usar los parámetros de la request como respaldo
        console.log(`⚠️ No se pudo obtener información completa del lead, usando parámetros de la request como respaldo`);
        contextMessage += "\n\nLead Information (from request):";
        contextMessage += `\nLead ID: ${effectiveLeadId}`;
        if (name) contextMessage += `\nName: ${name}`;
        if (email) contextMessage += `\nEmail: ${email}`;
        if (phone) contextMessage += `\nPhone: ${phone}`;
      }

      contextMessage = await appendLeadRecordToContext(contextMessage, effectiveLeadId, effectiveSiteId);
    } else if (name || email || phone) {
      // Si no tenemos effectiveLeadId pero sí información de contacto de la request
      console.log(`📋 No hay lead_id efectivo, pero usando información de contacto disponible de la request`);
      contextMessage += "\n\nContact Information (no lead created yet):";
      if (name) contextMessage += `\nName: ${name}`;
      if (email) contextMessage += `\nEmail: ${email}`;
      if (phone) contextMessage += `\nPhone: ${phone}`;
    }
    
    if (effectiveConversationId && isValidUUID(effectiveConversationId)) {
      console.log(`🔄 Recuperando historial para la conversación: ${effectiveConversationId}`);
      const historyMessages = await ConversationService.getConversationHistory(effectiveConversationId);
      
      if (historyMessages && historyMessages.length > 0) {
        // Filter out any messages that might be duplicates of the current message
        // This prevents the current message from appearing twice in the context
        const filteredMessages = historyMessages.filter((msg: {role: string, content: string}) => {
          // No filtrar mensajes de asistente o team_member
          if (msg.role === 'assistant' || msg.role === 'team_member' || msg.role === 'system') {
            return true;
          }
          // Para mensajes de usuario o visitante, comparar el contenido
          return msg.content.trim() !== message.trim();
        });
        
        if (filteredMessages.length > 0) {
          const conversationHistory = ConversationService.formatConversationHistoryForContext(filteredMessages);
          contextMessage = `${contextMessage}\n\nConversation History:\n${conversationHistory}\n\nConversation ID: ${effectiveConversationId}`;
          console.log(`📜 Historial de conversación recuperado con ${filteredMessages.length} mensajes`);
        } else {
          contextMessage = `${contextMessage}\nConversation ID: ${effectiveConversationId}`;
        }
      } else {
        contextMessage = `${contextMessage}\nConversation ID: ${effectiveConversationId}`;
        console.log(`⚠️ No se encontró historial para la conversación: ${effectiveConversationId}`);
      }
    }

    if (effectiveSiteId) {
      contextMessage = await appendActivePromotionsToContext(contextMessage, effectiveSiteId);
    }
    
    // Temporal owns pre-response execution. Never run model turns from this
    // Vercel request: only read already-completed, server-bound results.
    if (isInternalServiceRequest(request) && effectiveSiteId && typeof origin_message_id === 'string' &&
        Array.isArray(channel_guidance_run_plan_ids)) {
      try {
        contextMessage += await getCompletedChannelMessageGuidance({
          siteId: effectiveSiteId,
          messageId: origin_message_id,
          channel: effectiveOrigin || (website_chat_origin ? 'web' : ''),
          runPlanIds: channel_guidance_run_plan_ids,
        });
      } catch (error) {
        // Guidance is advisory. Never fail or duplicate a customer reply just
        // because a read-only workflow result lookup is unavailable.
        console.error('[CustomerSupport] Channel guidance lookup failed:', error);
      }
    }
    contextMessage += getCustomerSupportPolicies();


return contextMessage;
}
