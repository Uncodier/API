import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para guardar mensajes en la base de datos
async function saveMessages(userId: string, interventionMessage: string, conversationId?: string, leadId?: string, visitorId?: string, conversationTitle?: string, agentId?: string, commandId?: string) {
  try {
    // Verificar si tenemos un ID de conversación
    if (!conversationId) {
      // Crear una nueva conversación si no existe
      const conversationData: any = { 
        user_id: userId
      };
      
      // Añadir lead_id, visitor_id y agent_id si están presentes
      if (leadId) conversationData.lead_id = leadId;
      if (visitorId) conversationData.visitor_id = visitorId;
      if (agentId) conversationData.agent_id = agentId;
      // Añadir el título si está presente
      if (conversationTitle) conversationData.title = conversationTitle;
      
      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert([conversationData])
        .select()
        .single();
      
      if (convError) {
        console.error('Error al crear conversación de intervención:', convError);
        return null;
      }
      
      conversationId = conversation.id;
      console.log(`🗣️ Nueva conversación creada con ID: ${conversationId}`);
    } else if (conversationTitle) {
      // Actualizar el título de la conversación existente si se proporciona uno nuevo
      const { error: updateError } = await supabaseAdmin
        .from('conversations')
        .update({ 
          title: conversationTitle
        })
        .eq('id', conversationId);
      
      if (updateError) {
        console.error('Error al actualizar título de conversación:', updateError);
        // No fallamos toda la operación si solo falla la actualización del título
        console.log('Continuando con el guardado de mensajes...');
      } else {
        console.log(`✏️ Título de conversación actualizado: "${conversationTitle}"`);
      }
    }
    
    // Guardar el mensaje de intervención del equipo
    const interventionMessageData: any = {
      conversation_id: conversationId,
      user_id: userId,
      content: interventionMessage,
      role: 'team_member'
    };
    
    // Añadir lead_id, visitor_id y agent_id si están presentes
    if (leadId) interventionMessageData.lead_id = leadId;
    if (visitorId) interventionMessageData.visitor_id = visitorId;
    if (agentId) interventionMessageData.agent_id = agentId;
    if (commandId) interventionMessageData.command_id = commandId;
    
    const { data: savedInterventionMessage, error: interventionMsgError } = await supabaseAdmin
      .from('messages')
      .insert([interventionMessageData])
      .select()
      .single();
    
    if (interventionMsgError) {
      console.error('Error al guardar mensaje de intervención:', interventionMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje de intervención guardado con ID: ${savedInterventionMessage.id}`);
    
    return {
      conversationId,
      interventionMessageId: savedInterventionMessage.id,
      conversationTitle
    };
  } catch (error) {
    console.error('Error al guardar mensaje de intervención en la base de datos:', error);
    return null;
  }
}

// Función para obtener la información del agente desde la base de datos
async function getAgentInfo(agentId: string): Promise<{ site_id?: string } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente para intervención: ${agentId}`);
    
    // Consultar el agente en la base de datos - Solo obtenemos los campos necesarios
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, site_id')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del agente para intervención:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el agente con ID: ${agentId}`);
      return null;
    }
    
    console.log(`✅ Información del agente recuperada para intervención: site_id=${data.site_id || 'N/A'}`);
    
    return {
      site_id: data.site_id
    };
  } catch (error) {
    console.error('Error al obtener información del agente para intervención:', error);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from the request
    const { conversationId, message, agentId, user_id, conversation_title, lead_id, visitor_id, site_id: requestSiteId } = body;
    
    // Validate required parameters
    if (!message) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } },
        { status: 400 }
      );
    }
    
    if (!agentId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'agentId is required' } },
        { status: 400 }
      );
    }
    
    if (!user_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'user_id is required' } },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(user_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'user_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Obtener información del agente (solo site_id si es necesario)
    const agentInfo = await getAgentInfo(agentId);
    
    if (!agentInfo) {
      return NextResponse.json(
        { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
        { status: 404 }
      );
    }
    
    // Use site_id from request if provided, otherwise use the one from the agent
    const site_id = requestSiteId || agentInfo.site_id;
    
    console.log(`Procesando intervención para agente: ${agentId}, user_id: ${user_id}, site: ${site_id || 'N/A'}`);
    
    // Usar el título de la conversación proporcionado o crear uno por defecto
    const conversationTitle = conversation_title || "Intervention Conversation";
    
    // Guardar los mensajes en la base de datos - Eliminamos la generación del command_id aleatorio
    const savedMessages = await saveMessages(
      user_id,
      message,
      conversationId,
      lead_id,
      visitor_id,
      conversationTitle,
      agentId
    );
    
    // Verificar que se guardaron correctamente los mensajes
    if (!savedMessages) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'MESSAGE_SAVE_FAILED', 
            message: 'The intervention message could not be saved correctly' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Generar un ID único para la intervención
    const interventionId = uuidv4();
    
    // Si todo es correcto, devolvemos la respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          interventionId,
          status: 'completed',
          conversation_id: savedMessages.conversationId,
          conversation_title: savedMessages.conversationTitle,
          message: {
            content: message,
            message_id: savedMessages.interventionMessageId,
            role: 'team_member',
            user_id: user_id
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud de intervención:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the intervention request' } },
      { status: 500 }
    );
  }
} 