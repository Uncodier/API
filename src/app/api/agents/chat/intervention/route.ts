import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowService } from '@/lib/services/workflow-service';

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

// Función para detectar el canal de una conversación
async function getConversationChannel(conversationId: string): Promise<{ channel?: string; leadPhone?: string; leadEmail?: string; visitorPhone?: string } | null> {
  try {
    if (!conversationId || !isValidUUID(conversationId)) {
      console.log(`⚠️ ID de conversación no válido: ${conversationId}`);
      return null;
    }

    console.log(`🔍 Detectando canal para conversación: ${conversationId}`);

    // Obtener información de la conversación con lead y visitor
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .select(`
        id,
        channel,
        custom_data,
        lead_id,
        visitor_id,
        leads:lead_id (
          phone,
          email
        ),
        visitors:visitor_id (
          custom_data
        )
      `)
      .eq('id', conversationId)
      .single();

    if (error) {
      console.error('Error al obtener información de conversación:', error);
      return null;
    }

    if (!conversation) {
      console.log(`⚠️ No se encontró la conversación: ${conversationId}`);
      return null;
    }

    // Detectar el canal
    let channel = null;

    // 1. Verificar campo directo channel
    if (conversation.channel) {
      channel = conversation.channel;
    }
    // 2. Verificar custom_data.channel como fallback
    else if (conversation.custom_data && conversation.custom_data.channel) {
      channel = conversation.custom_data.channel;
    }
    // 3. Verificar custom_data.source (formato anterior)
    else if (conversation.custom_data && conversation.custom_data.source) {
      channel = conversation.custom_data.source;
    }

    console.log(`📺 Canal detectado: "${channel || 'sin canal'}" para conversación ${conversationId}`);

    // Obtener información de contacto según el canal
    let leadPhone = null;
    let leadEmail = null;
    let visitorPhone = null;

    // Información del lead
    if (conversation.leads) {
      const lead = conversation.leads as any;
      leadPhone = lead.phone;
      leadEmail = lead.email;
    }

    // Información del visitor (para WhatsApp)
    if (conversation.visitors) {
      const visitor = conversation.visitors as any;
      if (visitor && visitor.custom_data && visitor.custom_data.whatsapp_phone) {
        visitorPhone = visitor.custom_data.whatsapp_phone;
      }
    }

    return {
      channel,
      leadPhone,
      leadEmail,
      visitorPhone
    };
  } catch (error) {
    console.error('Error al detectar canal de conversación:', error);
    return null;
  }
}

// Función para enviar mensaje según el canal usando workflows de Temporal
async function sendMessageByChannel(
  channel: string,
  message: string,
  contactInfo: { leadPhone?: string; leadEmail?: string; visitorPhone?: string },
  siteId: string,
  agentId: string,
  conversationId: string,
  leadId?: string
): Promise<{ success: boolean; method?: string; error?: string; workflowId?: string }> {
  try {
    console.log(`📤 Enviando mensaje por canal usando workflows de Temporal: ${channel}`);
    
    const workflowService = WorkflowService.getInstance();

    if (channel === 'whatsapp') {
      // Para WhatsApp, priorizar el teléfono del visitor (más específico) o del lead
      const phoneNumber = contactInfo.visitorPhone || contactInfo.leadPhone;
      
      if (!phoneNumber) {
        return {
          success: false,
          error: 'No se encontró número de teléfono para envío por WhatsApp'
        };
      }

      console.log(`📱 Enviando mensaje de intervención por WhatsApp usando workflow a: ${phoneNumber.substring(0, 5)}***`);

      // Usar sendWhatsappFromAgent workflow para intervenciones
      const result = await workflowService.sendWhatsappFromAgent({
        phone_number: phoneNumber,
        message,
        from: 'Equipo de Soporte',
        site_id: siteId,
        agent_id: agentId,
        lead_id: leadId
      });

      return {
        success: result.success,
        method: 'whatsapp',
        workflowId: result.workflowId,
        error: result.error?.message
      };

    } else if (channel === 'email') {
      // Para email, usar el email del lead
      const email = contactInfo.leadEmail;
      
      if (!email) {
        return {
          success: false,
          error: 'No se encontró dirección de email para envío por correo'
        };
      }

      console.log(`📧 Enviando mensaje de intervención por email usando workflow a: ${email}`);

      // Usar sendEmailFromAgent workflow 
      const result = await workflowService.sendEmailFromAgent({
        email,
        from: 'Equipo de Soporte',
        subject: 'Respuesta de nuestro equipo',
        message,
        site_id: siteId,
        agent_id: agentId,
        lead_id: leadId
      });

      return {
        success: result.success,
        method: 'email',
        workflowId: result.workflowId,
        error: result.error?.message
      };

    } else {
      console.log(`ℹ️ Canal "${channel}" no requiere envío externo (web/chat)`);
      return {
        success: true,
        method: 'none',
        error: 'No external sending required for this channel'
      };
    }

  } catch (error) {
    console.error('Error al enviar mensaje por canal usando workflows:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
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

    // Detectar canal y enviar mensaje si es necesario
    let channelSendResult = null;
    
    if (savedMessages.conversationId && site_id) {
      console.log(`🔍 Detectando canal para envío de intervención...`);
      
      const conversationInfo = await getConversationChannel(savedMessages.conversationId);
      
      if (conversationInfo && conversationInfo.channel) {
        const { channel, leadPhone, leadEmail, visitorPhone } = conversationInfo;
        
        console.log(`📺 Canal detectado: "${channel}" - iniciando envío externo`);
        
        channelSendResult = await sendMessageByChannel(
          channel,
          message,
          { leadPhone, leadEmail, visitorPhone },
          site_id,
          agentId,
          savedMessages.conversationId,
          lead_id
        );
        
        if (channelSendResult.success) {
          console.log(`✅ Mensaje de intervención enviado exitosamente por ${channelSendResult.method} usando workflow ${channelSendResult.workflowId}`);
        } else {
          console.error(`❌ Error enviando mensaje de intervención usando workflow:`, channelSendResult.error);
        }
      } else {
        console.log(`ℹ️ No se detectó canal específico o no requiere envío externo`);
      }
    }

    // Generar un ID único para la intervención
    const interventionId = uuidv4();

    // Preparar respuesta con información del envío por canal y workflows
    const responseData: any = {
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
    };

    // Agregar información del envío por canal usando workflows si está disponible
    if (channelSendResult) {
      responseData.channel_send = {
        success: channelSendResult.success,
        method: channelSendResult.method,
        workflowId: channelSendResult.workflowId,
        error: channelSendResult.error
      };
    }

    // Si todo es correcto, devolvemos la respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: responseData
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