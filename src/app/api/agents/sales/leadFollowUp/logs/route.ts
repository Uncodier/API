import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createTask } from '@/lib/database/task-db';
import { v4 as uuidv4 } from 'uuid';
import { 
  getLeadInfo, 
  getPreviousInteractions, 
  buildEnrichedContext 
} from '@/lib/helpers/lead-context-helper';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función genérica para encontrar un agente activo por role
async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente activo con role "${role}" para el sitio: ${siteId}`);
    
    // Solo buscamos por site_id, role y status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error al buscar agente con role "${role}":`, error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente activo con role "${role}" para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con role "${role}" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error al buscar agente con role "${role}":`, error);
    return null;
  }
}

// Función para encontrar un agente de ventas activo para un sitio
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

// Función para crear una conversación para un canal específico
async function createChannelConversation(data: {
  siteId: string;
  leadId: string;
  userId: string;
  agentId?: string;
  channel: string;
  title?: string;
  commandIds?: { sales?: string; copywriter?: string };
}): Promise<string | null> {
  try {
    // No crear conversación para notifications
    if (data.channel === 'notification') {
      console.log(`🚫 Saltando creación de conversación para canal notification`);
      return null;
    }

    const conversationData: any = {
      user_id: data.userId,
      site_id: data.siteId,
      lead_id: data.leadId,
      title: data.title || `${data.channel} Follow-up`,
      channel: data.channel, // Nueva propiedad channel
      custom_data: {
        channel: data.channel,
        follow_up_type: 'lead_nurture',
        command_ids: data.commandIds || {}
      },
      status: 'active'
    };

    if (data.agentId) {
      conversationData.agent_id = data.agentId;
    }

    console.log(`🗣️ Creando conversación para canal ${data.channel}:`, conversationData);

    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .insert([conversationData])
      .select()
      .single();

    if (error) {
      console.error(`Error al crear conversación para canal ${data.channel}:`, error);
      return null;
    }

    console.log(`✅ Conversación creada exitosamente para canal ${data.channel}: ${conversation.id}`);
    return conversation.id;
  } catch (error) {
    console.error(`Error en createChannelConversation para canal ${data.channel}:`, error);
    return null;
  }
}

// Función para crear conversaciones y mensajes por canal
async function createChannelConversationsAndMessages(
  messages: Record<string, any>,
  leadData: any,
  siteId: string,
  leadId: string,
  userId: string,
  agentId?: string,
  commandIds?: { sales?: string; copywriter?: string }
): Promise<{conversations: Record<string, string>, messages: Record<string, string>}> {
  try {
    const conversations: Record<string, string> = {};
    const messagesByChannel: Record<string, string> = {};
    
    for (const [channel, messageData] of Object.entries(messages)) {
      if (!messageData || typeof messageData !== 'object') continue;

      // Saltarse el canal notification ya que no crea conversación
      if (channel === 'notification') {
        console.log(`🚫 Saltando canal notification - no se crea conversación`);
        continue;
      }

      // Crear conversación para este canal
      const conversationId = await createChannelConversation({
        siteId,
        leadId,
        userId,
        agentId,
        channel,
        title: messageData.title,
        commandIds
      });

      if (!conversationId) {
        console.error(`❌ No se pudo crear conversación para canal ${channel}`);
        continue;
      }

      conversations[channel] = conversationId;

      // Crear mensaje para esta conversación - solo el contenido del mensaje
      const messageContent = messageData.message || '';

      const messageRecord: any = {
        conversation_id: conversationId,
        content: messageContent,
        role: 'system',
        user_id: userId,
        custom_data: {
          channel: channel,
          follow_up_type: 'lead_nurture',
          title: messageData.title,
          strategy: messageData.strategy,
          original_message: messageData.message
        }
      };

      if (leadData?.id) {
        messageRecord.lead_id = leadData.id;
      }

      if (agentId) {
        messageRecord.agent_id = agentId;
      }

      console.log(`💬 Creando mensaje para canal ${channel}...`);

      const { data: message, error } = await supabaseAdmin
        .from('messages')
        .insert([messageRecord])
        .select()
        .single();

      if (error) {
        console.error(`Error al crear mensaje para canal ${channel}:`, error);
        continue;
      }

      messagesByChannel[channel] = message.id;
      console.log(`✅ Mensaje creado para canal ${channel}: ${message.id}`);
    }

    return { conversations, messages: messagesByChannel };
  } catch (error) {
    console.error('Error en createChannelConversationsAndMessages:', error);
    return { conversations: {}, messages: {} };
  }
}

// Función para crear tarea de awareness si es necesario
async function createAwarenessTaskIfNeeded(
  leadData: any,
  siteId: string,
  userId: string,
  conversationId: string,
  commandIds?: { sales?: string; copywriter?: string }
): Promise<string | null> {
  try {
    const leadStage = leadData?.status?.toLowerCase() || leadData?.stage?.toLowerCase() || 'unknown';
    
    // Crear tarea de awareness si el lead está en etapas tempranas
    const earlyStages = ['new', 'cold', 'unqualified', 'awareness', 'interest', 'consideration', 'unknown'];
    
    if (!earlyStages.includes(leadStage)) {
      console.log(`🚫 No se creará tarea de awareness - Lead stage: ${leadStage}`);
      return null;
    }

    console.log(`📋 Creando tarea de awareness para lead en stage: ${leadStage}`);

    const taskTitle = `Lead Awareness Follow-up: ${leadData?.name || leadData?.email || 'Unknown Lead'}`;
    const taskDescription = `Follow-up task created for lead ${leadData?.name || leadData?.email} from ${leadData?.company || 'Unknown Company'}.

Lead Stage: ${leadStage}
Email: ${leadData?.email || 'Not provided'}
Phone: ${leadData?.phone || 'Not provided'}
Company: ${leadData?.company || 'Not provided'}

This task was automatically created as part of the lead follow-up sequence to ensure proper awareness-stage nurturing.

Related conversation: ${conversationId}`;

    const taskData = {
      title: taskTitle,
      description: taskDescription,
      type: 'awareness',
      status: 'active',
      stage: 'pending',
      priority: 2, // Medium priority
      user_id: userId,
      site_id: siteId,
      lead_id: leadData?.id || undefined,
      command_id: commandIds?.sales || undefined,
      notes: `Auto-generated from lead follow-up sequence. Conversation ID: ${conversationId}`,
      scheduled_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // Scheduled for tomorrow
    };

    const task = await createTask(taskData);
    console.log(`✅ Tarea de awareness creada: ${task.id}`);
    
    return task.id;
  } catch (error) {
    console.error('Error en createAwarenessTaskIfNeeded:', error);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud (mismos que leadFollowUp)
    const { 
      siteId, 
      leadId, 
      userId, 
      agent_id,
      followUpType,
      leadStage,
      previousInteractions,
      leadData,
      productInterest,
      followUpInterval,
      messages, // Datos de los mensajes generados
      command_ids // IDs de los comandos ejecutados
    } = body;
    
    // Validar parámetros requeridos
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!leadId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leadId is required' } },
        { status: 400 }
      );
    }

    if (!userId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required' } },
        { status: 400 }
      );
    }

    // Buscar automáticamente el agente de ventas (Sales/CRM Specialist) para el sitio
    console.log(`🔍 Buscando agente Sales/CRM Specialist para el sitio: ${siteId}`);
    const salesAgentResult = await findActiveSalesAgent(siteId);
    let effectiveAgentId = agent_id; // Usar el proporcionado como fallback
    
    if (salesAgentResult) {
      effectiveAgentId = salesAgentResult.agentId;
      console.log(`✅ Agente Sales/CRM Specialist encontrado y será usado: ${effectiveAgentId}`);
    } else {
      console.log(`⚠️ No se encontró agente Sales/CRM Specialist para el sitio. ${agent_id ? `Usando agent_id proporcionado: ${agent_id}` : 'Continuando sin agente específico'}`);
    }

    // Obtener información del lead si no se proporcionó
    let effectiveLeadData = leadData;
    if (!effectiveLeadData || Object.keys(effectiveLeadData).length === 0) {
      const leadInfo = await getLeadInfo(leadId);
      if (leadInfo) {
        effectiveLeadData = leadInfo;
      }
    }

    if (!effectiveLeadData) {
      return NextResponse.json(
        { success: false, error: { code: 'LEAD_NOT_FOUND', message: 'Lead information not found' } },
        { status: 404 }
      );
    }

    // Paso 1: Crear conversaciones y mensajes por canal si se proporcionaron
    let channelConversations: Record<string, string> = {};
    let channelMessages: Record<string, string> = {};
    
    if (messages && typeof messages === 'object' && Object.keys(messages).length > 0) {
      const result = await createChannelConversationsAndMessages(
        messages,
        effectiveLeadData,
        siteId,
        leadId,
        userId,
        effectiveAgentId,
        command_ids
      );
      channelConversations = result.conversations;
      channelMessages = result.messages;
    }

    // Paso 2: Crear tarea de awareness si es necesario
    // Usar la primera conversación creada como referencia para la tarea
    const firstConversationId = Object.values(channelConversations)[0] || null;
    const awarenessTaskId = await createAwarenessTaskIfNeeded(
      effectiveLeadData,
      siteId,
      userId,
      firstConversationId || `No conversations created`,
      command_ids
    );

    // Respuesta exitosa
    return NextResponse.json({
      success: true,
      data: {
        conversations: channelConversations,
        messages: channelMessages,
        awareness_task_id: awarenessTaskId,
        lead: effectiveLeadData,
        agent_info: {
          agent_id: effectiveAgentId,
          agent_found: !!salesAgentResult,
          agent_role: salesAgentResult ? 'Sales/CRM Specialist' : 'Not found'
        },
        created_at: new Date().toISOString(),
        summary: {
          conversations_created: Object.keys(channelConversations).length,
          messages_created: Object.keys(channelMessages).length,
          channels: Object.keys(channelConversations),
          awareness_task_created: !!awarenessTaskId,
          lead_stage: effectiveLeadData?.status || effectiveLeadData?.stage || 'unknown'
        }
      }
    });
    
  } catch (error) {
    console.error('Error general en la ruta de logs de lead follow-up:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
} 