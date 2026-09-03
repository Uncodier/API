import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkflowService } from '@/lib/services/workflow-service';
import { sanitizeZavuRecipient } from '@/lib/services/channels/ChannelSendService';

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export type ChannelContactInfo = {
  channel?: string;
  channelDelivery?: boolean;
  leadPhone?: string;
  leadEmail?: string;
  visitorPhone?: string;
};

export type ChannelSendReason = 'missing_contact' | 'workflow_start_failed';

export type ChannelSendResult = {
  success: boolean;
  method?: string;
  error?: string;
  workflowId?: string;
  workflowStarted?: boolean;
  reason?: ChannelSendReason;
};

export async function getConversationChannel(
  conversationId: string
): Promise<ChannelContactInfo | null> {
  try {
    if (!conversationId || !isValidUUID(conversationId)) {
      console.log(`⚠️ ID de conversación no válido: ${conversationId}`);
      return null;
    }

    console.log(`🔍 Detectando canal para conversación: ${conversationId}`);

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

    let channel = null;
    if (conversation.channel) {
      channel = conversation.channel;
    } else if (conversation.custom_data && conversation.custom_data.channel) {
      channel = conversation.custom_data.channel;
    } else if (conversation.custom_data && conversation.custom_data.source) {
      channel = conversation.custom_data.source;
    }

    console.log(`📺 Canal detectado: "${channel || 'sin canal'}" para conversación ${conversationId}`);

    let leadPhone = null;
    let leadEmail = null;
    let visitorPhone = null;

    if (conversation.leads) {
      const lead = conversation.leads as any;
      leadPhone = lead.phone;
      leadEmail = lead.email;
    }

    if (conversation.visitors) {
      const visitor = conversation.visitors as any;
      if (visitor && visitor.custom_data && visitor.custom_data.whatsapp_phone) {
        visitorPhone = visitor.custom_data.whatsapp_phone;
      }
    }

    return {
      channel,
      channelDelivery: conversation.custom_data?.channel_delivery === true,
      leadPhone,
      leadEmail,
      visitorPhone
    };
  } catch (error) {
    console.error('Error al detectar canal de conversación:', error);
    return null;
  }
}

async function getRelevantMessageId(conversationId: string): Promise<string | null> {
  try {
    console.log(`🔍 Obteniendo message_id relevante para conversación: ${conversationId}`);

    let { data: message, error } = await supabaseAdmin
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .not('role', 'in', '("system","team_member")')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !message) {
      const fallbackQuery = await supabaseAdmin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      message = fallbackQuery.data;
      error = fallbackQuery.error;
    }

    if (error || !message) {
      console.warn(`⚠️ No se pudo obtener message_id para conversación ${conversationId}:`, error);
      return null;
    }

    return message.id;
  } catch (error) {
    console.error('❌ Error al obtener message_id desde la base de datos:', error);
    return null;
  }
}

export async function sendMessageByChannel(
  channel: string,
  message: string,
  contactInfo: { leadPhone?: string; leadEmail?: string; visitorPhone?: string; channelDelivery?: boolean },
  siteId: string,
  agentId: string | null | undefined,
  conversationId: string,
  leadId?: string,
  messageId?: string
): Promise<ChannelSendResult> {
  try {
    console.log(`📤 Starting Temporal send for channel: ${channel}`);

    const workflowService = WorkflowService.getInstance();

    let effectiveMessageId = messageId;
    if (!effectiveMessageId) {
      const dbMessageId = await getRelevantMessageId(conversationId);
      effectiveMessageId = dbMessageId || undefined;
    }

    const OUTSTAND_CHANNELS = ['facebook', 'instagram', 'threads', 'linkedin', 'x', 'twitter', 'youtube'];

    const useChannelDelivery =
      contactInfo.channelDelivery === true ||
      channel === 'telegram' ||
      channel === 'messenger' ||
      OUTSTAND_CHANNELS.includes(channel);

    if (useChannelDelivery) {
      let recipient =
        channel === 'email'
          ? contactInfo.leadEmail
          : contactInfo.visitorPhone || contactInfo.leadPhone;

      if (recipient && (channel === 'telegram' || channel === 'messenger' || channel === 'zavu')) {
        recipient = sanitizeZavuRecipient(recipient);
      }

      // For outstand channels we don't need a phone/email, just pass leadId or dummy value
      if (!recipient && OUTSTAND_CHANNELS.includes(channel)) {
        recipient = leadId || 'social-comment-user';
      }

      if (!recipient) {
        return {
          success: false,
          workflowStarted: false,
          reason: 'missing_contact',
          error: `No se encontró destinatario para envío por ${channel}`,
        };
      }

      const result = await workflowService.sendChannelMessageFromAgent({
        channel,
        to: recipient,
        message,
        site_id: siteId,
        subject: channel === 'email' ? 'Respuesta de nuestro equipo' : undefined,
        agent_id: agentId || undefined,
        conversation_id: conversationId,
        lead_id: leadId,
        message_id: effectiveMessageId,
      });

      return {
        success: result.success,
        method: channel,
        workflowId: result.workflowId,
        workflowStarted: result.success === true && !!result.workflowId,
        reason: result.success ? undefined : 'workflow_start_failed',
        error: result.error?.message,
      };
    }

    if (channel === 'whatsapp') {
      const phoneNumber = contactInfo.visitorPhone || contactInfo.leadPhone;

      if (!phoneNumber) {
        return {
          success: false,
          workflowStarted: false,
          reason: 'missing_contact',
          error: 'No se encontró número de teléfono para envío por WhatsApp'
        };
      }

      const result = await workflowService.sendWhatsappFromAgent({
        phone_number: phoneNumber,
        message,
        from: 'Equipo de Soporte',
        site_id: siteId,
        agent_id: agentId || undefined,
        conversation_id: conversationId,
        lead_id: leadId,
        message_id: effectiveMessageId
      });

      return {
        success: result.success,
        method: 'whatsapp',
        workflowId: result.workflowId,
        workflowStarted: result.success === true && !!result.workflowId,
        reason: result.success ? undefined : 'workflow_start_failed',
        error: result.error?.message
      };
    }

    if (channel === 'email') {
      const email = contactInfo.leadEmail;

      if (!email) {
        return {
          success: false,
          workflowStarted: false,
          reason: 'missing_contact',
          error: 'No se encontró dirección de email para envío por correo'
        };
      }

      const result = await workflowService.sendEmailFromAgent({
        email,
        from: 'Equipo de Soporte',
        subject: 'Respuesta de nuestro equipo',
        message,
        site_id: siteId,
        agent_id: agentId || undefined,
        lead_id: leadId,
        message_id: effectiveMessageId
      });

      return {
        success: result.success,
        method: 'email',
        workflowId: result.workflowId,
        workflowStarted: result.success === true && !!result.workflowId,
        reason: result.success ? undefined : 'workflow_start_failed',
        error: result.error?.message
      };
    }

    console.log(`ℹ️ Canal "${channel}" no requiere envío externo (web/chat)`);
    return {
      success: true,
      method: 'none',
      workflowStarted: false,
      error: 'No external sending required for this channel'
    };
  } catch (error) {
    console.error('Error al enviar mensaje por canal usando workflows:', error);
    return {
      success: false,
      workflowStarted: false,
      reason: 'workflow_start_failed',
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
  }
}
