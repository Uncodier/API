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
 * Fallback search for messages by recipient, timestamp, and subject
 * Used when agentmail_message_id is not available or set to "unknown"
 */
export async function findMessageByDeliveryDetails(
  recipient: string,
  timestamp: string,
  subject?: string
): Promise<{ id: string; custom_data: any } | null> {
  try {
    console.log(`[AgentMail] 🔍 Fallback search: recipient=${recipient}, timestamp=${timestamp}, subject=${subject}`);

    // Validate timestamp before using it
    const eventTime = new Date(timestamp);
    if (isNaN(eventTime.getTime())) {
      console.error(`[AgentMail] ❌ Invalid timestamp provided: "${timestamp}" - Cannot perform fallback search`);
      return null;
    }

    // Create a time window (±5 minutes)
    const timeStart = new Date(eventTime.getTime() - 5 * 60 * 1000).toISOString();
    const timeEnd = new Date(eventTime.getTime() + 5 * 60 * 1000).toISOString();

    // Helper function to query messages
    const queryMessages = async (start: string, end: string) => {
      return await supabaseAdmin
        .from('messages')
        .select('id, custom_data, created_at')
        .gte('created_at', start)
        .lte('created_at', end)
        .eq('role', 'assistant') // Sent messages are assistant role
        .order('created_at', { ascending: false })
        .limit(50); // Get more results to filter in-memory
    };

    // Phase 1: Search in short time window (±5 minutes)
    let { data: allMessages, error } = await queryMessages(timeStart, timeEnd);

    if (error) {
      console.error('[AgentMail] ❌ Query error in fallback search:', error);
      return null;
    }

    // Phase 2: If no messages found, search in extended time window (±24 hours)
    if (!allMessages || allMessages.length === 0) {
      console.log('[AgentMail] ⚠️ No messages found in short time window (±5 min). Extending search to ±24h...');
      
      const extendedStart = new Date(eventTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const extendedEnd = new Date(eventTime.getTime() + 24 * 60 * 60 * 1000).toISOString();
      
      const { data: extendedMessages, error: extendedError } = await queryMessages(extendedStart, extendedEnd);
      
      if (extendedError) {
        console.error('[AgentMail] ❌ Query error in extended fallback search:', extendedError);
        return null;
      }
      
      if (!extendedMessages || extendedMessages.length === 0) {
        console.log('[AgentMail] ⚠️ No messages found in extended time window (±24h)');
        return null;
      }

      console.log(`[AgentMail] 🔍 Found ${extendedMessages.length} messages in extended window (±24h)`);
      allMessages = extendedMessages;
    } else {
      console.log(`[AgentMail] 🔍 Found ${allMessages.length} messages in short time window (±5 min)`);
    }

    console.log(`[AgentMail] 🔍 Filtering ${allMessages.length} candidate messages by recipient...`);

    // Filter messages by recipient in-memory (handle multiple storage locations and formats)
    const matchingMessages = allMessages.filter(msg => {
      const customData = msg.custom_data || {};
      
      // Check multiple possible locations for recipient data:
      // 1. custom_data.delivery.to (array or string) - added by webhook updates
      const deliveryTo = customData.delivery?.to;
      if (deliveryTo) {
        if (Array.isArray(deliveryTo)) {
          if (deliveryTo.includes(recipient)) return true;
        } else if (deliveryTo === recipient) {
          return true;
        }
      }
      
      // 2. custom_data.delivery.details.recipient (string) - from initial creation
      if (customData.delivery?.details?.recipient === recipient) {
        return true;
      }
      
      // 3. custom_data.to (fallback, top-level)
      const topLevelTo = customData.to;
      if (topLevelTo) {
        if (Array.isArray(topLevelTo)) {
          if (topLevelTo.includes(recipient)) return true;
        } else if (topLevelTo === recipient) {
          return true;
        }
      }
      
      // 4. custom_data.recipient (used by AgentMailSendService/EmailSendService)
      if (customData.recipient === recipient) {
        return true;
      }
      
      return false;
    });

    if (matchingMessages.length === 0) {
      console.log(`[AgentMail] ⚠️ No messages found matching recipient: ${recipient}`);
      return null;
    }

    console.log(`[AgentMail] 🔍 Found ${matchingMessages.length} message(s) matching recipient`);

    // If subject is provided, try to match it
    if (subject) {
      const matchedMessage = matchingMessages.find(msg => 
        msg.custom_data?.subject === subject ||
        msg.custom_data?.delivery?.subject === subject ||
        msg.custom_data?.delivery?.details?.subject === subject
      );
      
      if (matchedMessage) {
        console.log(`[AgentMail] ✅ Found message by subject match: ${matchedMessage.id}`);
        return matchedMessage;
      }
      
      // Subject was provided but no match found - don't return unrelated message
      console.warn(
        `[AgentMail] ⚠️ Subject provided ("${subject}") but no matching message found in time window. ` +
        `Found ${matchingMessages.length} message(s) to recipient ${recipient} but none matched the subject. ` +
        `Returning null to avoid updating wrong message.`
      );
      return null;
    }

    // No subject provided - return the most recent message in time window
    console.log(`[AgentMail] ✅ Found message by time window (no subject filter): ${matchingMessages[0].id}`);
    return matchingMessages[0];

  } catch (error) {
    console.error('[AgentMail] Error in fallback search:', error);
    return null;
  }
}

/**
 * Finds a message with fallback mechanism
 * First tries to find by agentmail_message_id, then falls back to delivery details
 */
export async function findMessageWithFallback(
  agentmailMessageId: string,
  fallbackData?: {
    recipient?: string;
    timestamp?: string;
    subject?: string;
  }
): Promise<{ id: string; custom_data: any; foundViaFallback?: boolean } | null> {
  // Try primary search first
  const primaryResult = await findMessageByAgentMailId(agentmailMessageId);
  
  if (primaryResult) {
    return primaryResult;
  }

  // If fallback data is not provided, don't use fallback
  if (!fallbackData || !fallbackData.recipient || !fallbackData.timestamp) {
    console.log('[AgentMail] ⚠️ No fallback data available, skipping fallback search');
    return null;
  }

  // Try fallback search
  // NOTE: We always attempt fallback when primary search fails, regardless of message_id validity.
  // This is critical for messages created without agentmail_message_id (e.g., from customerSupport agent).
  // The fallback search itself is safe due to matching on recipient, timestamp, and subject.
  console.log('[AgentMail] 🔄 Attempting fallback search...');
  const fallbackResult = await findMessageByDeliveryDetails(
    fallbackData.recipient,
    fallbackData.timestamp,
    fallbackData.subject
  );

  if (fallbackResult) {
    return { ...fallbackResult, foundViaFallback: true };
  }

  return null;
}

/**
 * Updates a message with AgentMail event information
 */
export async function updateMessageWithAgentMailEvent(
  options: UpdateMessageOptions & { agentmailMessageId?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const { messageId, status, eventType, eventMetadata, timestamp, agentmailMessageId } = options;

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

    // Backfill agentmail_message_id if provided and not already set (or if set to "unknown")
    if (agentmailMessageId && 
        agentmailMessageId !== 'unknown' && 
        (!currentMessage.custom_data?.agentmail_message_id || 
         currentMessage.custom_data.agentmail_message_id === 'unknown')) {
      console.log(`[AgentMail] 🔄 Backfilling agentmail_message_id: ${agentmailMessageId}`);
      updatedCustomData.agentmail_message_id = agentmailMessageId;
      
      // Also update delivery details for consistency
      if (updatedCustomData.delivery?.details) {
        updatedCustomData.delivery.details.api_messageId = agentmailMessageId;
      }
    }

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













