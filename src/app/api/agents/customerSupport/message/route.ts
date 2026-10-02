import { NextResponse } from 'next/server';
import { manageLeadCreation } from '@/lib/services/leads/lead-service';
import { OutstandLeadIdentityError } from '@/lib/services/leads/outstand-comment-identity';
import { WhatsAppLeadService } from '@/lib/services/whatsapp/WhatsAppLeadService';
import { ConversationService } from '@/lib/services/conversation-service';
import { visitorAuthorizationErrorResponse } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { isValidUUID, findActiveCustomerSupportAgent, getAgentInfo } from './agent-data';
import { readSupportRequest } from './request';
import { buildSupportContext } from './context';
import { generateSupportReply } from './generate';
import { extractSupportResults } from './results';
import { saveMessages } from './save-messages';
import { corsHeaders } from './cors';
import { ensureCommentConversation, bindCommentAgent } from '@/lib/services/social-comments/conversations';
import { SocialCommentError } from '@/lib/services/social-comments/metadata';

export async function POST(request: Request) {
  try {
    const parsed = await readSupportRequest(request);
    if (parsed instanceof Response) return parsed;
    const { body, browserIdentity } = parsed;
    // Obtener información de ubicación y tiempo del request
    const requestTimestamp = new Date().toISOString();
    const clientIP = request.headers.get('x-forwarded-for') || 
                    request.headers.get('x-real-ip') || 
                    request.headers.get('x-client-ip') || 
                    request.headers.get('cf-connecting-ip') || 
                    'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const acceptLanguage = request.headers.get('accept-language') || 'unknown';
    
    console.log(`⏰ Request Info - Timestamp: ${requestTimestamp}, IP: ${clientIP}, User-Agent: ${userAgent}`);
    
    // Extract required parameters from the request
    const { 
      conversationId, 
      userId, 
      message, 
      agentId, 
      site_id, 
      lead_id, 
      visitor_id,
      name,
      email,
      phone,
      website_chat_origin, // Nuevo parámetro para indicar si el origen es "website_chat"
      lead_notification, // Nuevo parámetro para indicar si se debe enviar una notificación por email
      origin, // Nuevo parámetro para indicar el canal de origen: 'website', 'email', 'whatsapp'
      origin_message_id, // Parámetro opcional que se agrega como metadata al message del user
      channel_delivery,
      require_approval,
      custom_data: inboundCustomData,
      channel_guidance_run_plan_ids,
    } = body;
    
    // Validar el parámetro origin si está presente
    const validOrigins = ['website', 'email', 'whatsapp', 'voice', 'chat', 'website_chat', 'none', 'api', 'telegram', 'messenger', 'instagram', 'facebook', 'threads', 'linkedin', 'x', 'youtube'];
    
    // Si no se proporciona origin pero hay header origin, usar 'website' automáticamente
    let effectiveOrigin = origin;
    if (!effectiveOrigin && request.headers.get('origin')) {
      effectiveOrigin = 'website';
      console.log(`🌐 No se proporcionó origin, pero se detectó header origin. Estableciendo automáticamente: ${effectiveOrigin}`);
    }
    
    if (effectiveOrigin && !validOrigins.includes(effectiveOrigin)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: `origin must be one of: ${validOrigins.join(', ')}` } },
        { status: 400 }
      );
    }
    
    if (!message) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } },
        { status: 400 }
      );
    }
    
    // Establecer el site_id efectivo
    let effectiveSiteId = site_id;
    if (effectiveSiteId) {
      console.log(`📍 Using provided site_id: ${effectiveSiteId}`);
    } else {
      console.log(`⚠️ No site_id provided for request`);
    }
    
    // Determinar el origen del lead basado en los parámetros
    let leadOrigin = 'chat'; // valor por defecto
    
    if (effectiveOrigin) {
      // Si se proporciona 'origin', usarlo directamente
      leadOrigin = effectiveOrigin;
      console.log(`🏷️ Origen del lead establecido desde 'origin': ${leadOrigin}`);
    } else if (website_chat_origin === true) {
      // Si website_chat_origin=true, usar 'website_chat' (para mantener compatibilidad)
      leadOrigin = 'website_chat';
      console.log(`🏷️ Origen del lead establecido desde 'website_chat_origin': ${leadOrigin}`);
    }
    
    console.log(`🏷️ Origen final del lead: ${leadOrigin}`);
    
    // Variables para gestión de lead y conversación
    let effectiveLeadId: string | null = null;
    let isNewLead = false;
    let taskId: string | null = null;
    let effectiveConversationId = conversationId;
    
    // Manejo especial para WhatsApp
    if (leadOrigin === 'whatsapp' && phone && effectiveSiteId) {
      console.log(`📱 Detectado origen WhatsApp - usando WhatsAppLeadService`);
      
      try {
        const whatsappResult = await WhatsAppLeadService.findOrCreateLeadAndConversation({
          phoneNumber: phone,
          senderName: name,
          siteId: effectiveSiteId,
          userId: userId,
          businessAccountId: body.businessAccountId // Usar businessAccountId si está disponible
        });
        
        effectiveLeadId = whatsappResult.leadId;
        isNewLead = whatsappResult.isNewLead;
        
        // Si encontramos una conversación de WhatsApp reciente, usarla
        if (whatsappResult.conversationId && !conversationId) {
          effectiveConversationId = whatsappResult.conversationId;
          console.log(`💬 Usando conversación de WhatsApp existente: ${effectiveConversationId}`);
        }
        
        // Para WhatsApp no creamos tareas automáticamente como en website_chat
        console.log(`📱 WhatsApp lead management completed - Lead: ${effectiveLeadId}, Conversation: ${effectiveConversationId || 'nueva'}`);
        
      } catch (error) {
        console.error(`❌ Error en WhatsAppLeadService:`, error);
        // Fallback al servicio estándar
        console.log(`🔄 Usando servicio estándar como fallback`);
        const leadManagementResult = await manageLeadCreation({
          leadId: lead_id,
          name,
          email,
          phone,
          siteId: effectiveSiteId,
          visitorId: visitor_id,
          origin: leadOrigin,
          createTask: false
        });
        
        effectiveLeadId = leadManagementResult.leadId;
        isNewLead = leadManagementResult.isNewLead;
        taskId = leadManagementResult.taskId;
      }
    } else {
      // Gestionar lead_id utilizando el servicio estándar para otros orígenes
        const leadManagementResult = await manageLeadCreation({
          leadId: lead_id,
          name,
          email,
          phone,
          siteId: effectiveSiteId,
          visitorId: visitor_id,
          origin: leadOrigin,
          createTask: website_chat_origin === true,
          // The lead service gates the stable author lookup on the new contract;
          // browser and legacy social/DM requests must retain their old behavior.
          socialCommentData: browserIdentity ? undefined : inboundCustomData,
          socialHandle: typeof inboundCustomData?.account_username === 'string'
            ? inboundCustomData.account_username
            : (typeof inboundCustomData?.social_handle === 'string' ? inboundCustomData.social_handle : undefined)
        });
      
      effectiveLeadId = leadManagementResult.leadId;
      isNewLead = leadManagementResult.isNewLead;
      taskId = leadManagementResult.taskId;
    }
    
    // Verificar si tenemos un lead_id efectivo después de la gestión
    if (effectiveLeadId) {
      console.log(`👤 Usando lead_id: ${effectiveLeadId} para esta conversación. Es nuevo: ${isNewLead}`);
      if (taskId) {
        console.log(`✅ Tarea creada para el lead con ID: ${taskId}`);
      }
    } else {
      console.log(`⚠️ No hay lead_id disponible para esta conversación. Causas posibles:`);
      if (!name && !email && !phone) {
        console.log(`   - No se proporcionó información de contacto (nombre, email o teléfono)`);
      } else if (!name) {
        console.log(`   - Se proporcionó email/teléfono pero falta nombre`);
      } else {
        console.log(`   - Error al crear/buscar el lead en la base de datos (ver errores anteriores)`);
      }
    }

    if (inboundCustomData?.source === 'comment') {
      effectiveConversationId = await ensureCommentConversation({
        siteId: effectiveSiteId, metadata: inboundCustomData,
        conversationId, leadId: effectiveLeadId || undefined,
      });
    }

    // Use the ordinary channel lookup only outside the comment namespace.
    if (!effectiveConversationId && leadOrigin !== 'whatsapp' && leadOrigin !== 'website_chat') {
      console.log(`🔍 Buscando conversación existente para origen "${effectiveOrigin || leadOrigin}"`);
      
      const existingConversationId = await ConversationService.findExistingConversation(
        effectiveLeadId || undefined,
        visitor_id,
        effectiveSiteId,
        effectiveOrigin || leadOrigin,
        phone,
        email
      );
      
      if (existingConversationId) {
        effectiveConversationId = existingConversationId;
        console.log(`✅ Usando conversación existente encontrada: ${effectiveConversationId}`);
      } else {
        console.log(`📝 No se encontró conversación existente, se creará una nueva`);
      }
    } else if (!effectiveConversationId && leadOrigin === 'website_chat') {
      console.log(`🌐 Para website_chat sin conversation_id, siempre se creará una nueva conversación`);
    }
    
    // Buscar agente de soporte al cliente activo si no se proporciona un agent_id
    let effectiveAgentId = agentId;
    let agentUserId: string | null = null;
    
    if (!effectiveAgentId) {
      if (effectiveSiteId) {
        // Buscar un agente activo en la base de datos para el sitio
        const foundAgent = await findActiveCustomerSupportAgent(effectiveSiteId);
        if (foundAgent) {
          effectiveAgentId = foundAgent.agentId;
          agentUserId = foundAgent.userId;
          console.log(`🤖 Usando agente de soporte al cliente encontrado: ${effectiveAgentId} (user_id: ${agentUserId})`);
        } else {
          // Usar un valor predeterminado como último recurso
          effectiveAgentId = 'default_customer_support_agent';
          console.log(`⚠️ No se encontró un agente activo, usando valor predeterminado: ${effectiveAgentId}`);
        }
      } else {
        // No tenemos site_id, usamos valor predeterminado
        effectiveAgentId = 'default_customer_support_agent';
        console.log(`⚠️ No se puede buscar un agente sin site_id, usando valor predeterminado: ${effectiveAgentId}`);
      }
    } else if (isValidUUID(effectiveAgentId)) {
      // Si ya tenemos un agentId válido, obtenemos su información completa
      const agentInfo = await getAgentInfo(effectiveAgentId);
      if (agentInfo) {
        agentUserId = agentInfo.user_id;
        // Si no tenemos site_id, usamos el del agente
        if (!effectiveSiteId && agentInfo.site_id) {
          effectiveSiteId = agentInfo.site_id;
          console.log(`📍 Usando site_id del agente: ${effectiveSiteId}`);
        }
      }
    }
    
    // Determinamos qué ID usar para el comando (preferimos userId si está disponible)
    if (inboundCustomData?.source === 'comment' && isValidUUID(effectiveAgentId)) {
      await bindCommentAgent(effectiveSiteId, effectiveConversationId, effectiveAgentId);
    }
    // Ahora también consideramos el user_id del agente como opción
    const effectiveUserId = userId || agentUserId || visitor_id || lead_id;
    
    if (!effectiveUserId) {
      console.error(`❌ No se pudo determinar un user_id válido para el comando`);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'Unable to determine a valid user_id for the command' } },
        { status: 400 }
      );
    }
    
    console.log(`Creando comando para agente: ${effectiveAgentId}, usuario: ${effectiveUserId}, site: ${effectiveSiteId || 'N/A'}`);
    
    const contextMessage = await buildSupportContext({ request, message, name, email, phone, requestTimestamp, clientIP, userAgent, acceptLanguage, effectiveOrigin, effectiveLeadId, effectiveConversationId, effectiveSiteId, origin_message_id, channel_guidance_run_plan_ids, website_chat_origin });
    const generated = await generateSupportReply({ effectiveUserId, effectiveAgentId, effectiveSiteId, effectiveLeadId, contextMessage, agentUserId, request });
    if (generated instanceof Response) return generated;
    const { executedCommand, effectiveDbUuid } = generated;
    const { assistantMessage, conversationTitle, isRobot, isTransactionalMessage, isErratic } = extractSupportResults(executedCommand);
    // Usando lead_id efectivo al guardar los mensajes
    // Envolver en try-catch para manejar error SKIP_DATABASE
    let savedMessages;
    try {
      savedMessages = await saveMessages(
        effectiveUserId, 
        message, 
        assistantMessage, 
        effectiveConversationId, 
        conversationTitle, 
        effectiveLeadId || undefined, 
        visitor_id, 
        effectiveAgentId, 
        effectiveSiteId, 
        (effectiveDbUuid && isValidUUID(effectiveDbUuid)) ? effectiveDbUuid : undefined,
        effectiveOrigin || (leadOrigin !== 'chat' ? leadOrigin : undefined), // Usar origin si está disponible, o leadOrigin si no es 'chat'
        isRobot,
        isTransactionalMessage,
        isErratic,
        origin_message_id,
        channel_delivery === true,
        require_approval === true,
        inboundCustomData && typeof inboundCustomData === 'object' ? inboundCustomData : undefined
      );
    } catch (error: any) {
      // Si el error es SKIP_DATABASE, retornar respuesta sin crear objetos en DB
      if (error.code === 'SKIP_DATABASE' && error.results) {
        console.log(`🚨 SKIP_DATABASE detectado - retornando resultados sin crear objetos en DB`);
        return NextResponse.json(
          { 
            success: true, 
            data: { 
              command_id: effectiveDbUuid,
              skip_database: true,
              results: {
                message: error.results.message || assistantMessage,
                conversation_title: error.results.conversation_title || conversationTitle,
                is_robot: error.results.is_robot || false,
                is_transactional_message: error.results.is_transactional_message || false,
                is_erratic: error.results.is_erratic || false
              },
              lead_id: effectiveLeadId || null,
              task_id: taskId || null,
              debug: {
                agent_id: effectiveAgentId,
                user_id: effectiveUserId,
                agent_user_id: agentUserId,
                site_id: effectiveSiteId
              }
            } 
          },
          { 
            status: 200,
            headers: corsHeaders(request)
          }
        );
      }
      // Si es otro error, relanzarlo
      throw error;
    }
    
    if (!savedMessages) {
      console.error(`❌ Error al guardar mensajes en la base de datos`);
      console.error(`❌ Context: command_id=${effectiveDbUuid}, lead_id=${effectiveLeadId}, conversation_id=${effectiveConversationId}`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'The command completed successfully but the messages could not be saved to the database. This may be due to a foreign key constraint failure, missing required data, or database connection issue. Check server logs for details.',
            details: 'saveMessages() returned null instead of saved messages. Possible causes: invalid foreign key references (command_id, lead_id, conversation_id), database constraint violations, or connection errors.'
          },
          data: {
            command_id: effectiveDbUuid,
            message: assistantMessage,
            conversation_title: conversationTitle,
            lead_id: effectiveLeadId || null,
            conversation_id: effectiveConversationId || null
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId,
            is_robot: isRobot,
            is_transactional: isTransactionalMessage,
            is_erratic: isErratic
          }
        },
        { 
          status: 500,
          headers: corsHeaders(request)
        }
      );
    }
    
    // Notificación por email removida - se eliminó sendLeadNotificationEmail
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid,
          conversation_id: savedMessages.conversationId,
          conversation_title: savedMessages.conversationTitle,
          lead_id: effectiveLeadId || null,
          task_id: taskId || null,
          messages: {
            user: {
              content: message,
              message_id: savedMessages.userMessageId,
              command_id: effectiveDbUuid
            },
            assistant: {
              content: assistantMessage,
              message_id: savedMessages.assistantMessageId,
              command_id: effectiveDbUuid
            }
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId
          }
        } 
      },
      { 
        status: 200,
        headers: corsHeaders(request)
      }
    );
  } catch (error) {
    if (error instanceof SocialCommentError) return NextResponse.json(
      { success: false, error: { code: 'SOCIAL_COMMENT_CONFLICT', message: error.message } },
      { status: error.status },
    );
    const authorizationResponse = visitorAuthorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    if (error instanceof OutstandLeadIdentityError) {
      return NextResponse.json(
        { success: false, error: { code: 'LEAD_IDENTITY_UNAVAILABLE', message: error.message } },
        { status: 503 }
      );
    }
    console.error(`❌ Error en el manejo de la solicitud:`, error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    );
  }
}

export async function OPTIONS(request: Request) {
  console.log("[CORS-PREFLIGHT] Handling OPTIONS request");
  
  // Obtener el origen de la solicitud
  const origin = request.headers.get('origin') || '*';
  console.log(`[CORS-PREFLIGHT] Request origin: ${origin}`);
  
  // Para seguir el mismo comportamiento del middleware, verificar si el origen está permitido
  const isAllowed = true; // Aquí podrías implementar la misma lógica de cors.config.js
  
  // Crear respuesta preflight
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request)
  });
}