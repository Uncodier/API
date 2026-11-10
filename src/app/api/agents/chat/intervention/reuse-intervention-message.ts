import { supabaseAdmin } from '@/lib/database/supabase-client';
import { validateResponseFormat, type ResponseFormat } from '@/lib/services/channels/response-format';
import { resolveAudioRouting } from '@/lib/services/channels/audio-routing';

export type SavedInterventionMessage = {
  conversationId: string;
  interventionMessageId: string;
  conversationTitle?: string;
  responseFormat?: ResponseFormat;
  channelDelivery?: boolean;
};

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function reuseInterventionMessage(
  messageId: string,
  conversationId: string,
  userId: string,
  content: string,
  options: { responseFormat?: ResponseFormat; channel?: string; siteId?: string; allowLegacyWhatsApp?: boolean } = {},
): Promise<SavedInterventionMessage | null> {
  if (!isValidUUID(messageId) || !isValidUUID(conversationId)) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('id, conversation_id, custom_data, content')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .eq('role', 'team_member')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    console.error('Intervention retry message not found:', error);
    return null;
  }

  const customData = { ...((data.custom_data as Record<string, unknown>) || {}) };
  // A retry may omit the selection, but may never change the saved choice
  // (including the legacy, unspecified mode).
  let responseFormat: ResponseFormat | undefined;
  try {
    responseFormat = validateResponseFormat(customData.response_format, options.channel || '');
  } catch { return null; }
  if (responseFormat === 'audio' && content.length > 4000) return null;
  if (options.responseFormat !== undefined && options.responseFormat !== responseFormat) return null;
  // A generic workflow cleanup can mark a message failed while an audio send
  // still owns it. Only a prepared, undispatched receipt is safe to resume.
  const audioDelivery = customData.audio_delivery as Record<string, unknown> | undefined;
  if (audioDelivery != null && (responseFormat !== 'audio' || audioDelivery.state !== 'ready')) return null;
  if (data.content !== content || customData.provider_call_id
    || ['sent', 'delivered', 'received', 'sending', 'queued', 'running', 'success', 'placement_unknown'].includes(String(customData.status))
    || ['success', 'completed', 'running', 'sending', 'queued'].includes(String(customData.command_status))
    || ['placement_unknown', 'placing', 'queued', 'ringing', 'in_progress', 'completed'].includes(String(customData.call_status))
    || (customData.status !== 'failed' && customData.command_status !== 'failed')) return null;
  // Resolve before the atomic claim, preserving any saved binding. Old manual
  // messages without one acquire it in the same CAS update as the retry claim.
  const audioRouting = responseFormat === 'audio' && options.siteId ? await resolveAudioRouting({
    siteId: options.siteId, conversationId, channel: options.channel || '',
    connectionId: customData.connection_id, allowLegacyWhatsApp: options.allowLegacyWhatsApp,
  }) : undefined;
  if (audioRouting) customData.connection_id = audioRouting.connectionId;
  delete customData.error_message;
  customData.command_status = 'pending';
  customData.status = 'pending';

  const { data: claimed, error: updateError } = await supabaseAdmin
    .from('messages')
    .update({ custom_data: customData })
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .eq('role', 'team_member')
    .eq('custom_data', JSON.stringify(data.custom_data))
    .select('id')
    .maybeSingle();

  if (updateError || !claimed) {
    console.error('Failed to clear failed status on intervention retry:', updateError);
    return null;
  }

  return {
    conversationId: data.conversation_id,
    interventionMessageId: data.id,
    ...(responseFormat !== undefined ? { responseFormat } : {}),
    ...(audioRouting ? { channelDelivery: audioRouting.kind === 'zavu' } : {}),
  };
}

export function interventionPostSaveErrorBody(
  savedMessages: SavedInterventionMessage | null,
  message = 'An error occurred while processing the intervention request'
) {
  return {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message,
    },
    data: savedMessages
      ? {
          message_id: savedMessages.interventionMessageId,
          conversation_id: savedMessages.conversationId,
        }
      : undefined,
  };
}
