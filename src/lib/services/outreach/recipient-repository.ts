import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Fail closed rather than silently truncate trusted channel identities. */
export async function loadOutreachConversations(siteId: string, leadId: string): Promise<any[]> {
  const conversations: any[] = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const { data, error } = await supabaseAdmin.from('conversations').select('id,site_id,lead_id,channel,custom_data')
      .eq('site_id', siteId).eq('lead_id', leadId).order('id').range(offset, offset + 999);
    if (error) throw error;
    conversations.push(...(data || []));
    if (!data || data.length < 1000) return conversations;
  }
  throw new Error('Too many conversations to safely resolve outreach recipients');
}