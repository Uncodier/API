import { supabaseAdmin } from '@/lib/database/supabase-server';

interface UpdateMessageOptions {
  messageId: string;
  status: 'sent' | 'delivered' | 'bounced' | 'complained' | 'rejected' | 'received';
  eventType: string;
  eventMetadata?: Record<string, any>;
  timestamp?: string;
}

/**
 * Finds a message in the database by AgentMail message_id
 * Searches in multiple possible locations in custom_data
 */
export async function findMessageByAgentMailId(
  agentmailMessageId: string
): Promise<{ id: string; custom_data: any } | null> {
  if (!agentmailMessageId) {
    return null;
  }

  console.log(`[AgentMail] 🔍 Searching for message with AgentMail ID: "${agentmailMessageId}"`);

  try {
    // Search in multiple possible locations where the message_id might be stored
    const searchQueries = [
      // Primary location: custom_data->>agentmail_message_id
      supabaseAdmin
        .from('messages')
        .select('id, custom_data')
        .filter('custom_data->>agentmail_message_id', 'eq', agentmailMessageId)
        .limit(1),

      // Alternative: custom_data->delivery->details->api_messageId
      supabaseAdmin
        .from('messages')
        .select('id, custom_data')
        .filter('custom_data->delivery->details->>api_messageId', 'eq', agentmailMessageId)
        .limit(1),

      // Alternative: custom_data->email_id (for compatibility)
      supabaseAdmin
        .from('messages')
        .select('id, custom_data')
        .filter('custom_data->>email_id', 'eq', agentmailMessageId)
        .limit(1),

      // Alternative: custom_data->message_id
      supabaseAdmin
        .from('messages')
        .select('id, custom_data')
        .filter('custom_data->>message_id', 'eq', agentmailMessageId)
        .limit(1),
    ];

    // Execute all searches in parallel
    const results = await Promise.allSettled(searchQueries);

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
        const foundMessage = result.value.data[0];
        console.log(`[AgentMail] ✅ Message found: ${foundMessage.id}`);
        return foundMessage;
      }
    }

    console.log(`[AgentMail] ⚠️ Message not found with AgentMail ID: "${agentmailMessageId}"`);
    return null;
  } catch (error) {
    console.error('[AgentMail] Error searching for message:', error);
    return null;
  }
}

/**
 * Updates a message with AgentMail event information
 */
export async function updateMessageWithAgentMailEvent(
  options: UpdateMessageOptions
): Promise<{ success: boolean; error?: string }> {
  try {
    const { messageId, status, eventType, eventMetadata, timestamp } = options;

    console.log(`[AgentMail] 🔄 Updating message ${messageId} with status: ${status}`);

    // Get current message to preserve existing custom_data
    const { data: currentMessage, error: fetchError } = await supabaseAdmin
      .from('messages')
      .select('custom_data')
      .eq('id', messageId)
      .limit(1)
      .single();

    if (fetchError || !currentMessage) {
      console.error('[AgentMail] ❌ Error fetching message:', fetchError);
      return { success: false, error: 'Message not found' };
    }

    // Merge with existing custom_data
    const updatedCustomData = {
      ...currentMessage.custom_data,
      status,
      agentmail: {
        ...(currentMessage.custom_data?.agentmail || {}),
        last_event: eventType,
        last_event_at: timestamp || new Date().toISOString(),
        events: [
          ...(currentMessage.custom_data?.agentmail?.events || []),
          {
            type: eventType,
            status,
            timestamp: timestamp || new Date().toISOString(),
            metadata: eventMetadata || {},
          },
        ],
      },
      delivery: {
        ...(currentMessage.custom_data?.delivery || {}),
        status,
        last_updated: timestamp || new Date().toISOString(),
        ...(eventMetadata || {}),
      },
      updated_at: new Date().toISOString(),
    };

    // Update the message
    const { error: updateError } = await supabaseAdmin
      .from('messages')
      .update({
        custom_data: updatedCustomData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', messageId);

    if (updateError) {
      console.error('[AgentMail] ❌ Error updating message:', updateError);
      return { success: false, error: updateError.message };
    }

    console.log(`[AgentMail] ✅ Message ${messageId} updated successfully`);
    return { success: true };
  } catch (error: any) {
    console.error('[AgentMail] ❌ Error in updateMessageWithAgentMailEvent:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}













