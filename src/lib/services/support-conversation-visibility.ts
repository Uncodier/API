import { supabaseAdmin } from '@/lib/database/supabase-client';

// Customer-facing service-role reads bypass RLS. Apply this to the conversation
// relation before counting, paging, selecting a thread, or embedding messages.
// A bare `neq` would silently drop legacy rows whose channel is SQL NULL.
export const CUSTOMER_CONVERSATION_FILTER = 'channel.is.null,channel.neq.internal_review';

// Support and chat can assign IDs before insertion. An existing ID, however,
// must name a customer-visible thread in the already authorized site.
export async function ingressConversationStatus(siteId: string, conversationId: string) {
  const { data, error } = await supabaseAdmin.from('conversations').select('site_id, channel')
    .eq('id', conversationId).maybeSingle();
  if (error) return 'unavailable';
  if (data && (data.site_id !== siteId || data.channel === 'internal_review')) return 'forbidden';
  return 'allowed';
}
