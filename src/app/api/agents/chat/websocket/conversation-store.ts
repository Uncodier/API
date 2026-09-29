import { supabaseAdmin } from '@/lib/database/supabase-client';

export function isValidUUID(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function getOrCreateConversation(
  visitorId: string, siteId: string, leadId: string | null, agentId?: string | null,
): Promise<string> {
  let query = supabaseAdmin.from('conversations').select('id')
    .eq('site_id', siteId).eq('status', 'active');
  // A remembered visitor must not select history belonging to a previous account.
  query = leadId ? query.eq('lead_id', leadId)
    : query.eq('visitor_id', visitorId).is('lead_id', null);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error('Unable to find conversation');
  if (data?.length) return data[0].id;

  if (agentId) {
    const { data: agent, error: agentError } = await supabaseAdmin.from('agents').select('id')
      .eq('id', agentId).eq('site_id', siteId).maybeSingle();
    if (agentError || !agent) throw new Error('Agent does not belong to the authorized site');
  }

  const { data: created, error: createError } = await supabaseAdmin.from('conversations')
    .insert([{
      visitor_id: visitorId, site_id: siteId, lead_id: leadId,
      status: 'active', title: 'New conversation',
      ...(agentId ? { agent_id: agentId } : {}),
    }]).select('id').single();
  // Never substitute another tenant if the authorized site does not exist.
  if (createError || !created) throw new Error('Unable to create conversation');
  return created.id;
}

export async function getConversationMessages(conversationId: string, limit = 50) {
  const { data, error } = await supabaseAdmin.from('messages').select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error('Unable to load conversation history');
  return (data || []).map(message => ({
    ...message,
    role: ['assistant', 'user', 'team_member'].includes(message.role) ? message.role : 'user',
  })).reverse();
}

export async function saveMessage(conversationId: string, content: string, visitorId: string) {
  const { data, error } = await supabaseAdmin.from('messages')
    .insert([{ conversation_id: conversationId, content, role: 'user', visitor_id: visitorId }])
    .select().single();
  if (error || !data) throw new Error('Unable to save message');
  return data;
}