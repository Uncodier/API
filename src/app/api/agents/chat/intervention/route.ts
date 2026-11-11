import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import {
  interventionPostSaveErrorBody,
  reuseInterventionMessage,
  type SavedInterventionMessage,
} from './reuse-intervention-message';
import { getConversationChannel, sendMessageByChannel } from './send-intervention-by-channel';
import { authorizeIntervention, InterventionRequestError } from './authorize-intervention';
import { SocialCommentError } from '@/lib/services/social-comments/metadata';
import { validateResponseFormat, type ResponseFormat } from '@/lib/services/channels/response-format';
import { AudioRoutingError, resolveAudioRouting } from '@/lib/services/channels/audio-routing';
import { validateOutboundMedia, type OutboundMediaInput } from '@/lib/services/channels/outbound-media';

const PENDING_CUSTOM_DATA = {
  command_status: 'pending',
  status: 'pending',
};

async function saveMessages(
  userId: string,
  interventionMessage: string,
  conversationId: string,
  leadId?: string,
  visitorId?: string,
  conversationTitle?: string,
  agentId?: string,
  commentMetadata?: Record<string, unknown>,
  responseFormat?: ResponseFormat,
  connectionId?: string,
  mediaInput?: OutboundMediaInput,
) {
  try {
    const interventionMessageData: any = {
      conversation_id: conversationId,
      user_id: userId,
      content: interventionMessage,
      role: 'team_member',
      custom_data: { ...commentMetadata, ...PENDING_CUSTOM_DATA,
        ...mediaInput,
        ...(connectionId !== undefined ? { connection_id: connectionId } : {}),
        ...(responseFormat !== undefined ? { response_format: responseFormat } : {}) },
    };

    if (leadId) interventionMessageData.lead_id = leadId;
    if (visitorId) interventionMessageData.visitor_id = visitorId;
    if (agentId) interventionMessageData.agent_id = agentId;

    const { data: savedInterventionMessage, error: interventionMsgError } = await supabaseAdmin
      .from('messages')
      .insert([interventionMessageData])
      .select()
      .single();

    if (interventionMsgError) {
      console.error('Failed to save intervention message:', interventionMsgError);
      return null;
    }

    return {
      conversationId,
      interventionMessageId: savedInterventionMessage.id,
      conversationTitle
    };
  } catch (error) {
    console.error('Failed to persist intervention message:', error);
    return null;
  }
}

export async function POST(request: Request) {
  let savedMessages: SavedInterventionMessage | null = null;
  try {
    let body: unknown;
    try { body = await request.json(); } catch {
      throw new InterventionRequestError('Invalid JSON body', 400);
    }
    const {
      conversationId, message, agentId, userId: user_id,
      leadId: lead_id, visitorId: visitor_id, siteId: site_id,
      messageId: requestMessageId, title: conversationTitle,
      commentMetadata, responseFormat: requestedResponseFormat,
      mediaInput: requestedMediaInput,
    } = await authorizeIntervention(request, body);

    // Resolve the stored conversation channel before any audio persistence or
    // retry claim. Caller-supplied channel hints are not accepted by the schema.
    const preflightChannel = requestedResponseFormat === 'audio' || requestMessageId || requestedMediaInput?.media_url
      ? (commentMetadata
        ? { channel: commentMetadata.network as string, channelDelivery: true, leadId: lead_id,
          leadPhone: undefined, leadEmail: undefined, visitorPhone: undefined }
        : await getConversationChannel(conversationId))
      : undefined;
    if (requestedResponseFormat === 'audio') {
      try { validateResponseFormat(requestedResponseFormat, preflightChannel?.channel || ''); }
      catch (error) { throw new InterventionRequestError((error as Error).message, 400); }
    }
    let responseFormat = requestedResponseFormat;
    let mediaInput: OutboundMediaInput | undefined = requestedMediaInput;
    try { await validateOutboundMedia({ ...mediaInput, response_format: responseFormat }, preflightChannel?.channel || 'web'); }
    catch (error) { throw new InterventionRequestError((error as Error).message, 400); }

    if (requestMessageId && conversationId) {
      savedMessages = await reuseInterventionMessage(requestMessageId, conversationId, user_id, message, {
        responseFormat: requestedResponseFormat, channel: preflightChannel?.channel,
        siteId: site_id, allowLegacyWhatsApp: preflightChannel?.channelDelivery !== true,
        mediaInput,
      });
      if (!savedMessages) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_REQUEST', message: 'Message is not retryable or its saved response format does not match' } },
          { status: 400 }
        );
      }
      responseFormat = savedMessages.responseFormat;
      mediaInput = savedMessages.mediaInput;
      if (responseFormat === 'audio' && preflightChannel) preflightChannel.channelDelivery = savedMessages.channelDelivery;
    } else {
      const audioRouting = responseFormat === 'audio' ? await resolveAudioRouting({
        siteId: site_id, conversationId, channel: preflightChannel!.channel!,
        allowLegacyWhatsApp: preflightChannel?.channelDelivery !== true,
      }) : undefined;
      if (audioRouting && preflightChannel) preflightChannel.channelDelivery = audioRouting.kind === 'zavu';
      savedMessages = await saveMessages(
        user_id,
        message,
        conversationId,
        lead_id,
        visitor_id,
        conversationTitle,
        agentId,
        commentMetadata,
        responseFormat,
        audioRouting?.connectionId,
        mediaInput,
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
      const conversationInfo = preflightChannel !== undefined ? preflightChannel : commentMetadata
        ? { channel: commentMetadata.network as string, channelDelivery: true, leadId: lead_id,
          leadPhone: undefined, leadEmail: undefined, visitorPhone: undefined }
        : await getConversationChannel(savedMessages.conversationId);

      if (conversationInfo && conversationInfo.channel) {
        const {
          channel,
          leadId: conversationLeadId,
          leadPhone,
          leadEmail,
          visitorPhone,
          channelDelivery,
        } = conversationInfo;

        channelSendResult = await sendMessageByChannel(
          channel,
          message,
          {
            leadId: conversationLeadId,
            leadPhone,
            leadEmail,
            visitorPhone,
            channelDelivery,
          },
          site_id,
          agentId,
          savedMessages.conversationId,
          lead_id,
          savedMessages.interventionMessageId,
          responseFormat,
          mediaInput,
        );

        const needsWorkflow =
          channel === 'whatsapp' ||
          channel === 'email' ||
          channel === 'telegram' ||
          channel === 'messenger' ||
          channelDelivery === true;
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
        user_id: user_id,
        custom_data: { ...commentMetadata, ...mediaInput,
          ...(responseFormat !== undefined ? { response_format: responseFormat } : {}) },
      }
    };

    if (channelSendResult) {
      responseData.channel_send = {
        success: channelSendResult.success,
        method: channelSendResult.method,
        workflowId: channelSendResult.workflowId,
        callId: channelSendResult.callId,
        delivery_status: channelSendResult.delivery_status,
        error: channelSendResult.error
      };
    }

    return NextResponse.json(
      { success: true, data: responseData },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof InterventionRequestError || error instanceof SocialCommentError || error instanceof AudioRoutingError) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: error.message } },
        { status: error.status },
      );
    }
    console.error('Failed to process intervention request:', error);
    return NextResponse.json(
      interventionPostSaveErrorBody(savedMessages),
      { status: 500 }
    );
  }
}
