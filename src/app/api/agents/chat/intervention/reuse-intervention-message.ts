import { supabaseAdmin } from '@/lib/database/supabase-client';

export type SavedInterventionMessage = {
  conversationId: string;
  interventionMessageId: string;
  conversationTitle?: string;
};

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function reuseInterventionMessage(
  messageId: string,
  conversationId: string
): Promise<SavedInterventionMessage | null> {
  if (!isValidUUID(messageId) || !isValidUUID(conversationId)) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('id, conversation_id, custom_data')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .eq('role', 'team_member')
    .single();

  if (error || !data) {
    console.error('Intervention retry message not found:', error);
    return null;
  }

  const customData = { ...((data.custom_data as Record<string, unknown>) || {}) };
  delete customData.error_message;
  customData.command_status = 'pending';
  customData.status = 'pending';

  const { error: updateError } = await supabaseAdmin
    .from('messages')
    .update({ custom_data: customData })
    .eq('id', messageId);

  if (updateError) {
    console.error('Failed to clear failed status on intervention retry:', updateError);
  }

  return {
    conversationId: data.conversation_id,
    interventionMessageId: data.id,
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
