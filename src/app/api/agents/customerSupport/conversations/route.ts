import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export interface GetConversationsParams {
  lead_id?: string;
  visitor_id?: string;
  user_id?: string;
  site_id?: string;
  agent_id?: string;
  /** Filter by conversations.status column (e.g. active, closed) */
  status?: string;
  /** Filter by conversations.channel (e.g. whatsapp, email, chat) */
  channel?: string;
  /** Filter by custom_data->>'status' (JSONB key inside custom_data) */
  custom_data_status?: string;
  limit?: number;
  offset?: number;
}

/**
 * Core logic for listing conversations. Callable from route or assistant protocol (no HTTP).
 */
export async function getConversationsCore(params: GetConversationsParams): Promise<{
  success: true;
  data: { conversations: any[]; pagination: { total: number; page: number; limit: number; pages: number } };
}> {
  const leadId = params.lead_id;
  const visitorId = params.visitor_id;
  const userId = params.user_id;
  const siteId = params.site_id;
  const agentId = params.agent_id;
  const status = params.status;
  const channel = params.channel;
  const customDataStatus = params.custom_data_status;
  const limit = params.limit ?? 10;
  const offset = params.offset ?? 0;

  if (!leadId && !visitorId && !userId && !siteId && !agentId) {
    throw new Error('INVALID_REQUEST: At least one of lead_id, visitor_id, user_id, site_id, or agent_id is required');
  }
  if (leadId && !isValidUUID(leadId)) throw new Error('INVALID_REQUEST: lead_id must be a valid UUID');
  if (visitorId && !isValidUUID(visitorId)) throw new Error('INVALID_REQUEST: visitor_id must be a valid UUID');
  if (userId && !isValidUUID(userId)) throw new Error('INVALID_REQUEST: user_id must be a valid UUID');
  if (siteId && !isValidUUID(siteId)) throw new Error('INVALID_REQUEST: site_id must be a valid UUID');
  if (agentId && !isValidUUID(agentId)) throw new Error('INVALID_REQUEST: agent_id must be a valid UUID');

  let query = supabaseAdmin
    .from('conversations')
    .select(
      `*, messages:messages(content, role, created_at, id)`,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (leadId) query = query.eq('lead_id', leadId);
  else if (visitorId) query = query.eq('visitor_id', visitorId);
  if (userId) query = query.eq('user_id', userId);
  if (siteId) query = query.eq('site_id', siteId);
  if (agentId) query = query.eq('agent_id', agentId);
  if (status) query = query.eq('status', status);
  if (channel) query = query.eq('channel', channel);
  if (customDataStatus) query = query.filter('custom_data->>status', 'eq', customDataStatus);

  const { data, error, count } = await query;
  if (error) throw new Error(`DATABASE_ERROR: ${error.message}`);

  const total = count ?? 0;
  const pages = Math.ceil(total / limit);
  const list = data ?? [];

  const processedConversations = list.map((conversation: any) => {
    const sortedMessages = conversation.messages
      ? [...conversation.messages].sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      : [];
    const lastMessage = sortedMessages.length > 0 ? sortedMessages[sortedMessages.length - 1] : null;
    return {
      ...conversation,
      messages: sortedMessages,
      last_message: lastMessage,
      message_count: sortedMessages.length
    };
  });

  return {
    success: true,
    data: {
      conversations: processedConversations,
      pagination: { total, page: Math.floor(offset / limit) + 1, limit, pages }
    }
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const leadId = url.searchParams.get('lead_id');
    const visitorId = url.searchParams.get('visitor_id');
    const userId = url.searchParams.get('user_id');
    const siteId = url.searchParams.get('site_id');
    const agentId = url.searchParams.get('agent_id');
    const limit = parseInt(url.searchParams.get('limit') || '10');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const debug = url.searchParams.get('debug') === 'true';

    const result = await getConversationsCore({
      lead_id: leadId ?? undefined,
      visitor_id: visitorId ?? undefined,
      user_id: userId ?? undefined,
      site_id: siteId ?? undefined,
      agent_id: agentId ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      channel: url.searchParams.get('channel') ?? undefined,
      custom_data_status: url.searchParams.get('custom_data_status') ?? undefined,
      limit,
      offset
    });

    return NextResponse.json({
      ...result,
      debug: debug ? { query_params: { leadId, visitorId, userId, siteId, agentId } } : undefined
    });
  } catch (err: any) {
    const message = err?.message ?? 'An error occurred while processing the request';
    const code = message.startsWith('INVALID_REQUEST') ? 400 : message.startsWith('DATABASE_ERROR') ? 500 : 500;
    return NextResponse.json(
      { success: false, error: { code: message.split(':')[0] || 'INTERNAL_SERVER_ERROR', message: message.replace(/^[A-Z_]+:\s*/, '') } },
      { status: code }
    );
  }
} 