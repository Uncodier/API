import { supabaseAdmin } from '@/lib/database/supabase-client';
// Function to check if a message with origin_message_id already exists and was responded to
export async function checkDuplicateOriginMessage(
  originMessageId: string,
  conversationId?: string,
  leadId?: string,
  siteId?: string
): Promise<{ isDuplicate: boolean; existingMessageId?: string; conversationId?: string }> {
  try {
    if (!originMessageId) {
      return { isDuplicate: false };
    }

    console.log(`🔍 [DUPLICATE_CHECK] Checking for duplicate origin_message_id: ${originMessageId}`);

    // Build query to find messages with matching origin_message_id
    let query = supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('messages')
      .select('id, conversation_id, role, created_at')
      .filter('custom_data->>origin_message_id', 'eq', originMessageId)
      .order('created_at', { ascending: false });

    // If we have conversationId, filter by it for better performance
    if (conversationId) {
      query = query.eq('conversation_id', conversationId);
    }

    // If we have leadId, filter by it
    if (leadId) {
      query = query.eq('lead_id', leadId);
    }

    // If we have siteId, we can filter by conversation's site_id
    // But we need to join with conversations table, so let's get all matches first
    const { data: matchingMessages, error } = await query;

    if (error) {
      console.error(`❌ [DUPLICATE_CHECK] Error querying messages:`, error);
      return { isDuplicate: false };
    }

    if (!matchingMessages || matchingMessages.length === 0) {
      console.log(`✅ [DUPLICATE_CHECK] No messages found with origin_message_id: ${originMessageId}`);
      return { isDuplicate: false };
    }

    console.log(`📊 [DUPLICATE_CHECK] Found ${matchingMessages.length} message(s) with origin_message_id: ${originMessageId}`);

    // Group messages by conversation_id
    const messagesByConversation = new Map<string, typeof matchingMessages>();
    for (const msg of matchingMessages) {
      if (!msg.conversation_id) continue;
      if (!messagesByConversation.has(msg.conversation_id)) {
        messagesByConversation.set(msg.conversation_id, []);
      }
      messagesByConversation.get(msg.conversation_id)!.push(msg);
    }

    // Check each conversation for user message + assistant response
    for (const [convId, messages] of Array.from(messagesByConversation.entries())) {
      // If we have siteId, verify the conversation belongs to that site
      if (siteId) {
        const { data: conv, error: convError } = await supabaseAdmin
          .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
          .from('conversations')
          .select('site_id')
          .eq('id', convId)
          .single();

        if (convError || !conv || conv.site_id !== siteId) {
          continue;
        }
      }

      // Find user message (should be the one with origin_message_id)
      const userMessage = messages.find((m: { id: any; conversation_id: any; role: any; created_at: any }) => m.role === 'user');
      if (!userMessage) continue;

      // Check if there's an assistant message after the user message
      const { data: assistantMessages, error: assistantError } = await supabaseAdmin
        .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('messages')
        .select('id, created_at')
        .eq('conversation_id', convId)
        .eq('role', 'assistant')
        .gt('created_at', userMessage.created_at)
        .limit(1);

      if (assistantError) {
        console.error(`❌ [DUPLICATE_CHECK] Error checking assistant messages:`, assistantError);
        continue;
      }

      if (assistantMessages && assistantMessages.length > 0) {
        console.log(`⚠️ [DUPLICATE_CHECK] Duplicate found! Message ${userMessage.id} with origin_message_id ${originMessageId} already has an assistant response in conversation ${convId}`);
        return {
          isDuplicate: true,
          existingMessageId: userMessage.id,
          conversationId: convId
        };
      }
    }

    console.log(`✅ [DUPLICATE_CHECK] No duplicate responses found for origin_message_id: ${originMessageId}`);
    return { isDuplicate: false };
  } catch (error: any) {
    console.error(`❌ [DUPLICATE_CHECK] Error in checkDuplicateOriginMessage:`, error);
    return { isDuplicate: false };
  }
}
