import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import {
  interventionPostSaveErrorBody,
  reuseInterventionMessage,
  type SavedInterventionMessage,
} from './reuse-intervention-message';
import { getConversationChannel, sendMessageByChannel } from './send-intervention-by-channel';

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

const PENDING_CUSTOM_DATA = {
  command_status: 'pending',
  status: 'pending',
};

async function saveMessages(
  userId: string,
  interventionMessage: string,
  conversationId?: string,
  leadId?: string,
  visitorId?: string,
  conversationTitle?: string,
  agentId?: string,
  commandId?: string
) {
  try {
    if (!conversationId) {
      const conversationData: any = { user_id: userId };
      if (leadId) conversationData.lead_id = leadId;
      if (visitorId) conversationData.visitor_id = visitorId;
      if (agentId) conversationData.agent_id = agentId;
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
    } else if (conversationTitle) {
      const { error: updateError } = await supabaseAdmin
        .from('conversations')
        .update({ title: conversationTitle })
        .eq('id', conversationId);

      if (updateError) {
        console.error('Error al actualizar título de conversación:', updateError);
      }
    }

    const interventionMessageData: any = {
      conversation_id: conversationId,
      user_id: userId,
      content: interventionMessage,
      role: 'team_member',
      custom_data: PENDING_CUSTOM_DATA,
    };

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

async function getAgentInfo(agentId: string): Promise<{ site_id?: string } | null> {
  try {
    if (!isValidUUID(agentId)) {
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, site_id')
      .eq('id', agentId)
      .single();

    if (error || !data) {
      return null;
    }

    return { site_id: data.site_id };
  } catch (error) {
    console.error('Error al obtener información del agente para intervención:', error);
    return null;
  }
}

export async function POST(request: Request) {
  let savedMessages: SavedInterventionMessage | null = null;
  try {
    const body = await request.json();

    const {
      conversationId: conversationIdCamel,
      conversation_id: conversationIdSnake,
      message,
      agentId,
      user_id,
      conversation_title,
      lead_id,
      visitor_id,
      site_id: requestSiteId,
      message_id: requestMessageId
    } = body;
    const conversationId = conversationIdCamel || conversationIdSnake;

    if (!message) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } },
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

    let agentInfo = null;
    if (agentId) {
      agentInfo = await getAgentInfo(agentId);
      if (!agentInfo) {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
    }

    const site_id = requestSiteId || (agentInfo ? agentInfo.site_id : null);
    const conversationTitle = conversation_title || "Intervention Conversation";

    if (requestMessageId && conversationId) {
      savedMessages = await reuseInterventionMessage(requestMessageId, conversationId);
      if (!savedMessages) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_REQUEST', message: 'message_id does not belong to this conversation' } },
          { status: 400 }
        );
      }
    } else {
      savedMessages = await saveMessages(
        user_id,
        message,
        conversationId,
        lead_id,
        visitor_id,
        conversationTitle,
        agentId
      );
    }

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

    let channelSendResult = null;

    if (savedMessages.conversationId && site_id) {
      const conversationInfo = await getConversationChannel(savedMessages.conversationId);

      if (conversationInfo && conversationInfo.channel) {
        const { channel, leadPhone, leadEmail, visitorPhone } = conversationInfo;

        channelSendResult = await sendMessageByChannel(
          channel,
          message,
          { leadPhone, leadEmail, visitorPhone },
          site_id,
          agentId,
          savedMessages.conversationId,
          lead_id,
          savedMessages.interventionMessageId
        );

        const needsWorkflow = channel === 'whatsapp' || channel === 'email';
        if (needsWorkflow && channelSendResult.reason === 'workflow_start_failed') {
          return NextResponse.json(
            interventionPostSaveErrorBody(
              savedMessages,
              channelSendResult.error || 'Failed to start delivery workflow'
            ),
            { status: 500 }
          );
        }
      }
    }

    const interventionId = uuidv4();
    const accepted = !channelSendResult || channelSendResult.success || channelSendResult.method === 'none';

    const responseData: any = {
      interventionId,
      status: accepted ? 'accepted' : 'channel_skipped',
      conversation_id: savedMessages.conversationId,
      conversation_title: savedMessages.conversationTitle,
      message: {
        content: message,
        message_id: savedMessages.interventionMessageId,
        role: 'team_member',
        user_id: user_id
      }
    };

    if (channelSendResult) {
      responseData.channel_send = {
        success: channelSendResult.success,
        method: channelSendResult.method,
        workflowId: channelSendResult.workflowId,
        error: channelSendResult.error
      };
    }

    return NextResponse.json(
      { success: true, data: responseData },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud de intervención:', error);
    return NextResponse.json(
      interventionPostSaveErrorBody(savedMessages),
      { status: 500 }
    );
  }
}
