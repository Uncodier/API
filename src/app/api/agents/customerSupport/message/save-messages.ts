import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ConversationService } from '@/lib/services/conversation-service';
import { isValidUUID, validateLeadExists } from './agent-data';
import { saveCommentMessages } from '@/lib/services/social-comments/persistence';
// Función para guardar mensajes en la base de datos
export async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, conversationTitle?: string, leadId?: string, visitorId?: string, agentId?: string, siteId?: string, commandId?: string, origin?: string, isRobot?: boolean, isTransactionalMessage?: boolean, isErratic?: boolean, originMessageId?: string, channelDelivery?: boolean, requireApproval?: boolean, inboundCustomData?: Record<string, unknown>) {
  if (inboundCustomData?.source === 'comment' && siteId && conversationId) {
    return saveCommentMessages({ siteId, conversationId, userId, userMessage, assistantMessage,
      metadata: inboundCustomData, leadId, agentId: agentId && isValidUUID(agentId) ? agentId : undefined,
      commandId, conversationTitle });
  }
  try {
    console.log(`💾 Guardando mensajes con: user_id=${userId}, agent_id=${agentId || 'N/A'}, site_id=${siteId || 'N/A'}, lead_id=${leadId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, command_id=${commandId || 'N/A'}, origin=${origin || 'N/A'}, is_robot=${isRobot || false}, is_transactional_message=${isTransactionalMessage || false}, is_erratic=${isErratic || false}`);
    
    // Si es robot, mensaje transaccional o errático, lanzar error para detener el flujo de creación en DB
    if (isRobot || isTransactionalMessage || isErratic) {
      console.log(`🚨 SKIP_DATABASE: is_robot=${isRobot}, is_transactional_message=${isTransactionalMessage}, is_erratic=${isErratic} - No se crearán objetos en la base de datos`);
      const error: any = new Error('SKIP_DATABASE');
      error.code = 'SKIP_DATABASE';
      error.results = {
        message: assistantMessage,
        conversation_title: conversationTitle,
        is_robot: isRobot || false,
        is_transactional_message: isTransactionalMessage || false,
        is_erratic: isErratic || false
      };
      throw error;
    }
    
    // Validar que el lead existe si se proporciona un leadId
    let validatedLeadId: string | undefined = leadId;
    if (leadId) {
      const leadExists = await validateLeadExists(leadId);
      if (!leadExists) {
        console.log(`⚠️ Lead ${leadId} no existe en la base de datos. Continuando sin lead_id para evitar error de foreign key.`);
        validatedLeadId = undefined;
      } else {
        console.log(`✅ Lead ${leadId} validado correctamente.`);
      }
    }
    
    let effectiveConversationId: string | undefined = conversationId;
    
    // Verificar si tenemos un ID de conversación
    if (conversationId) {
      // Verificamos primero que la conversación realmente existe en la base de datos
      console.log(`🔍 Verificando existencia de conversación: ${conversationId}`);
      const { data: existingConversation, error: checkError } = await supabaseAdmin
        .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
          .from('conversations')
        .select('id, user_id, lead_id, visitor_id, agent_id, site_id, custom_data')
        .eq('id', conversationId)
        .single();
      
      if (checkError || !existingConversation) {
        console.log(`⚠️ Conversación no encontrada en la base de datos, creando nueva: ${conversationId}`);
        // Si la conversación no existe aunque tengamos un ID, crearemos una nueva
        effectiveConversationId = undefined;
      } else {
        console.log(`✅ Conversación existente confirmada: ${conversationId}`);
        console.log(`📊 Datos de conversación existente:`, JSON.stringify(existingConversation));
      }
    }
    
    // Crear una nueva conversación si no existe
    if (!effectiveConversationId) {
      // Late re-check: try to find an existing conversation again to avoid race conditions (especially for WhatsApp)
      // Skip late re-check for website_chat origin - always create new conversations
      if (origin !== 'website_chat') {
        try {
          if (siteId && (validatedLeadId || visitorId)) {
            const lateOrigin = origin || undefined;
            const lateExistingConversationId = await ConversationService.findExistingConversation(
              validatedLeadId,
              visitorId,
              siteId,
              lateOrigin,
              undefined,
              undefined
            );
            if (lateExistingConversationId) {
              effectiveConversationId = lateExistingConversationId;
              console.log(`♻️ Late re-check found existing conversation: ${effectiveConversationId}`);
            }
          }
        } catch (lateErr) {
          console.log('⚠️ Late re-check for existing conversation failed:', lateErr);
        }
      } else {
        console.log(`🌐 Skipping late re-check for website_chat origin - will create new conversation`);
      }

      // If still no conversation, create a new one
      if (!effectiveConversationId) {
      // Crear una nueva conversación
      const conversationData: any = {
        // Añadir user_id obligatoriamente
        user_id: userId
      };
      
      // Añadir visitor_id, agent_id y site_id si están presentes
      if (visitorId) conversationData.visitor_id = visitorId;
      if (agentId) conversationData.agent_id = agentId;
      if (siteId) conversationData.site_id = siteId;
      
      // Añadir lead_id solo si está validado (existe en la base de datos)
      if (validatedLeadId) {
        conversationData.lead_id = validatedLeadId;
        console.log(`✅ Agregando lead_id validado ${validatedLeadId} a la nueva conversación`);
      } else if (leadId) {
        console.log(`⚠️ Lead ID ${leadId} no se agregará a la conversación porque no existe en la base de datos`);
      }
      
      // Añadir el título si está presente
      if (conversationTitle) conversationData.title = conversationTitle;
      
      // Añadir custom_data con channel si origin está presente
      if (origin || channelDelivery) {
        conversationData.custom_data = {
          ...(origin ? { channel: origin } : {}),
          ...(channelDelivery ? { channel_delivery: true } : {}),
        };
        if (origin) conversationData.channel = origin;
        console.log(`📺 Estableciendo channel="${origin}" channel_delivery=${!!channelDelivery} en custom_data`);
      }
      
      console.log(`🗣️ Creando nueva conversación con datos:`, JSON.stringify(conversationData));
      
      const { data: conversation, error: convError } = await supabaseAdmin
        .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
          .from('conversations')
        .insert([conversationData])
        .select()
        .single();
      
      if (convError) {
        console.error('Error al crear conversación:', convError);
        return null;
      }
      
      effectiveConversationId = conversation.id;
      console.log(`🗣️ Nueva conversación creada con ID: ${effectiveConversationId}`);
      }
    } else if (conversationTitle || siteId || validatedLeadId || origin || channelDelivery) {
      // Actualizar la conversación existente si se proporciona un nuevo título, site_id, lead_id o origin
      const updateData: any = {};
      if (conversationTitle) updateData.title = conversationTitle;
      if (siteId) updateData.site_id = siteId;
      if (validatedLeadId) updateData.lead_id = validatedLeadId;
      
      if (origin || channelDelivery) {
        // Primero obtenemos el custom_data existente
        const { data: existingConv, error: fetchError } = await supabaseAdmin
          .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
          .from('conversations')
          .select('custom_data')
          .eq('id', effectiveConversationId)
          .single();
        
        let existingCustomData = {};
        if (!fetchError && existingConv && existingConv.custom_data) {
          existingCustomData = existingConv.custom_data;
        }
        
        updateData.custom_data = {
          ...existingCustomData,
          ...(origin ? { channel: origin } : {}),
          ...(channelDelivery ? { channel_delivery: true } : {}),
        };
        if (origin) updateData.channel = origin;
        console.log(`📺 Actualizando channel="${origin}" channel_delivery=${!!channelDelivery} en custom_data`);
      }
      
      console.log(`✏️ Actualizando conversación: ${effectiveConversationId} con:`, JSON.stringify(updateData));
      
      const { error: updateError } = await supabaseAdmin
        .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
          .from('conversations')
        .update(updateData)
        .eq('id', effectiveConversationId);
      
      if (updateError) {
        console.error('Error al actualizar conversación:', updateError);
        // No fallamos toda la operación si solo falla la actualización
        console.log('Continuando con el guardado de mensajes...');
      } else {
        if (conversationTitle) {
          console.log(`✏️ Título de conversación actualizado: "${conversationTitle}"`);
        }
        if (siteId) {
          console.log(`🔗 Site ID de conversación actualizado: "${siteId}"`);
        }
        if (validatedLeadId) {
          console.log(`👤 Lead ID de conversación actualizado: "${validatedLeadId}"`);
        }
        if (origin) {
          console.log(`📺 Channel de conversación actualizado: "${origin}"`);
        }
      }
    }
    
    // Guardar el mensaje del usuario
    const userMessageObj: any = {
      conversation_id: effectiveConversationId,
      user_id: userId,
      content: userMessage,
      role: 'user'
    };
    
    // Agregar visitor_id si está presente
    if (visitorId) userMessageObj.visitor_id = visitorId;
    
    // Agregar lead_id si está validado (independientemente del agentId)
    if (validatedLeadId) {
      userMessageObj.lead_id = validatedLeadId;
      console.log(`👤 Agregando lead_id validado ${validatedLeadId} al mensaje del usuario`);
    }
    
    // Agregar agent_id si está presente
    if (agentId) userMessageObj.agent_id = agentId;
    
    // Agregar command_id si está presente y es un UUID válido
    if (commandId && isValidUUID(commandId)) {
      // Verify command exists in database before adding to message
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
        .from('commands')
        .select('id')
        .eq('id', commandId)
        .single();
      
      if (commandCheckError) {
        // Check if it's a "no rows found" error (PGRST116) or a real database error
        if (commandCheckError.code === 'PGRST116') {
          console.warn(`⚠️ Command ${commandId} does not exist in database (PGRST116), skipping command_id in user message`);
        } else {
          // Real database error - log it but don't add command_id to avoid invalid foreign key
          console.error(`❌ Database error checking command ${commandId}:`, commandCheckError);
          console.warn(`⚠️ Skipping command_id in user message due to database error (cannot verify existence)`);
        }
      } else if (commandExists) {
        userMessageObj.command_id = commandId;
      } else {
        console.warn(`⚠️ Command ${commandId} does not exist in database, skipping command_id in user message`);
      }
    }
    
    if (originMessageId || inboundCustomData) {
      userMessageObj.custom_data = {
        ...(userMessageObj.custom_data || {}),
        ...(inboundCustomData || {}),
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
      };
    }
    
    console.log(`💬 Guardando mensaje de usuario para conversación: ${effectiveConversationId}`);
    
    const { data: savedUserMessage, error: userMsgError } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('messages')
      .insert([userMessageObj])
      .select()
      .single();
    
    if (userMsgError) {
      console.error('Error al guardar mensaje del usuario:', userMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del usuario guardado con ID: ${savedUserMessage.id}`);
    
    // Guardar el mensaje del asistente
    const assistantMessageObj: any = {
      conversation_id: effectiveConversationId,
      user_id: null, // Agente no es usuario
      content: assistantMessage,
      role: 'assistant'
    };
    
    if (requireApproval) {
      assistantMessageObj.custom_data = {
        ...(assistantMessageObj.custom_data || {}),
        status: 'pending',
        ...(origin ? { channel: origin } : {}),
      };
      console.log(`⏳ Marcando mensaje del asistente como pending debido a requireApproval=true`);
    }
    
    // Agregar visitor_id si está presente
    if (visitorId) assistantMessageObj.visitor_id = visitorId;
    
    // Agregar lead_id si está validado (independientemente del agentId)
    if (validatedLeadId) {
      assistantMessageObj.lead_id = validatedLeadId;
      console.log(`👤 Agregando lead_id validado ${validatedLeadId} al mensaje del asistente`);
    }
    
    // Agregar agent_id si está presente
    if (agentId) assistantMessageObj.agent_id = agentId;
    
    // Agregar command_id si está presente y es un UUID válido
    if (commandId && isValidUUID(commandId)) {
      // Verify command exists in database before adding to message
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
        .from('commands')
        .select('id')
        .eq('id', commandId)
        .single();
      
      if (commandCheckError) {
        // Check if it's a "no rows found" error (PGRST116) or a real database error
        if (commandCheckError.code === 'PGRST116') {
          console.warn(`⚠️ Command ${commandId} does not exist in database (PGRST116), skipping command_id in assistant message`);
        } else {
          // Real database error - log it but don't add command_id to avoid invalid foreign key
          console.error(`❌ Database error checking command ${commandId}:`, commandCheckError);
          console.warn(`⚠️ Skipping command_id in assistant message due to database error (cannot verify existence)`);
        }
      } else if (commandExists) {
        assistantMessageObj.command_id = commandId;
      } else {
        console.warn(`⚠️ Command ${commandId} does not exist in database, skipping command_id in assistant message`);
      }
    }
    
    console.log(`💬 Guardando mensaje de asistente para conversación: ${effectiveConversationId}`);
    
    const { data: savedAssistantMessage, error: assistantMsgError } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('messages')
      .insert([assistantMessageObj])
      .select()
      .single();
    
    if (assistantMsgError) {
      console.error('Error al guardar mensaje del asistente:', assistantMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del asistente guardado con ID: ${savedAssistantMessage.id}`);
    
    // Verificamos que la conversación esté asociada correctamente
    const { data: finalConversation, error: finalCheckError } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
          .from('conversations')
      .select('id, user_id, lead_id, visitor_id, agent_id, site_id, title')
      .eq('id', effectiveConversationId)
      .single();
      
    if (!finalCheckError && finalConversation) {
      console.log(`✅ Verificación final de conversación: ${JSON.stringify(finalConversation)}`);
    } else {
      console.error(`❌ Error al verificar conversación final:`, finalCheckError);
    }
    
    return {
      conversationId: effectiveConversationId,
      userMessageId: savedUserMessage.id,
      assistantMessageId: savedAssistantMessage.id,
      conversationTitle
    };
  } catch (error: any) {
    // If this is a SKIP_DATABASE error, re-throw it so it can be handled by the caller
    if (error.code === 'SKIP_DATABASE') {
      console.log(`🔄 Re-throwing SKIP_DATABASE error to be handled by caller`);
      throw error;
    }
    // For any other error, log and return null
    console.error('Error al guardar mensajes en la base de datos:', error);
    return null;
  }
}
