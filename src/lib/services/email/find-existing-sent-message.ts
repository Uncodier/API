import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function findExistingSentMessage(
  conversationId: string,
  leadId: string,
  standardEmailId: string,
): Promise<string | null> {
  if (!standardEmailId) return null;
  try {
    const paths = [
      'custom_data->>email_id',
      'custom_data->delivery->>details->>api_messageId',
      'custom_data->delivery->>external_message_id',
    ];
    const results = await Promise.allSettled(
      paths.map((path) =>
        supabaseAdmin
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter(path, 'eq', standardEmailId)
          .limit(1),
      ),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data?.[0]?.id) {
        return result.value.data[0].id;
      }
    }
    return null;
  } catch (error) {
    console.error('[SENT_EMAIL_DEDUP] Standard ID lookup failed:', error);
    return null;
  }
}
