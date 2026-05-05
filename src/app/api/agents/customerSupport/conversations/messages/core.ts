import { supabaseAdmin } from '@/lib/database/supabase-client';

export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export interface GetMessagesParams {
  site_id: string;
  conversation_id?: string;
  /** Filter by messages.lead_id (UUID) */
  lead_id?: string;
  /** Filter by messages.role (e.g. user, assistant, system) */
  role?: string;
  /** Filter by messages.interaction (e.g. opened, clicked for email tracking) */
  interaction?: string;
  /** Filter by custom_data->>'status' (JSONB key inside message custom_data) */
  custom_data_status?: string;
  limit?: number;
  offset?: number;
}

/**
 * Core logic for listing messages. Callable from route or assistant protocol (no HTTP).
 */
export async function getMessagesCore(params: GetMessagesParams): Promise<{
  success: true;
  data: { messages: any[]; pagination: { total: number; page: number; limit: number; pages: number } };
}> {
  const {
    site_id: siteId,
    conversation_id: conversationId,
    lead_id: leadId,
    role: roleFilter,
    interaction: interactionFilter,
    custom_data_status: customDataStatus,
    limit = 50,
    offset = 0
  } = params;

  if (!siteId) throw new Error('INVALID_REQUEST: site_id is required');
  if (!isValidUUID(siteId)) throw new Error('INVALID_REQUEST: site_id must be a valid UUID');
  if (leadId && !isValidUUID(leadId)) throw new Error('INVALID_REQUEST: lead_id must be a valid UUID');

  // Clamp limit to avoid runaway queries and ensure at least 1
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  // Site-wide: no conversation_id
  if (!conversationId) {
    let siteQuery = supabaseAdmin
      .from('messages')
      .select('*, conversations!inner(site_id)', { count: 'exact' })
      .eq('conversations.site_id', siteId)
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1);
    if (leadId) siteQuery = siteQuery.eq('lead_id', leadId);
    if (roleFilter) siteQuery = siteQuery.eq('role', roleFilter);
    if (interactionFilter) siteQuery = siteQuery.eq('interaction', interactionFilter);
    if (customDataStatus) siteQuery = siteQuery.filter('custom_data->>status', 'eq', customDataStatus);

    const { data: siteMessages, error: siteMsgError, count: siteCount } = await siteQuery;

    if (siteMsgError) {
      const detail = typeof siteMsgError.message === 'string'
        ? siteMsgError.message
        : JSON.stringify(siteMsgError);
      throw new Error(`DATABASE_ERROR: ${detail}`);
    }

    const messagesOnly = (siteMessages ?? []).map((m: any) => {
      const { conversations: _c, ...rest } = m;
      return rest;
    });
    const total = siteCount ?? 0;
    const pages = Math.ceil(total / safeLimit);

    return {
      success: true,
      data: {
        messages: messagesOnly,
        pagination: { total, page: Math.floor(offset / safeLimit) + 1, limit: safeLimit, pages }
      }
    };
  }

  if (!isValidUUID(conversationId)) throw new Error('INVALID_REQUEST: conversation_id must be a valid UUID');

  const { data: conversation, error: conversationError } = await supabaseAdmin
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('site_id', siteId)
    .single();

  if (conversationError) {
    const detail = typeof conversationError.message === 'string'
      ? conversationError.message
      : JSON.stringify(conversationError);
    throw new Error(`DATABASE_ERROR: ${detail}`);
  }
  if (!conversation) throw new Error('NOT_FOUND: Conversation not found or does not belong to the specified site');

  let convMsgQuery = supabaseAdmin
    .from('messages')
    .select('*', { count: 'exact' })
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .range(offset, offset + safeLimit - 1);
  if (leadId) convMsgQuery = convMsgQuery.eq('lead_id', leadId);
  if (roleFilter) convMsgQuery = convMsgQuery.eq('role', roleFilter);
  if (interactionFilter) convMsgQuery = convMsgQuery.eq('interaction', interactionFilter);
  if (customDataStatus) convMsgQuery = convMsgQuery.filter('custom_data->>status', 'eq', customDataStatus);

  const { data: messages, error: messagesError, count } = await convMsgQuery;

  if (messagesError) {
    const detail = typeof messagesError.message === 'string'
      ? messagesError.message
      : JSON.stringify(messagesError);
    throw new Error(`DATABASE_ERROR: ${detail}`);
  }

  let syntheticMessages: any[] = [];
  try {
    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id, title, description, type, status, stage, priority, user_id, site_id, conversation_id, created_at, updated_at, assignee, serial_id, address')
      .eq('conversation_id', conversationId)
      .eq('site_id', siteId)
      .order('created_at', { ascending: true });

    if (!tasksError && tasks?.length) {
      syntheticMessages.push(
        ...tasks.map((task: any) => ({
          id: `task-${task.id}`,
          conversation_id: conversationId,
          content: `Task created: ${task.title}${task.description ? ` — ${task.description}` : ''}`,
          role: 'assistant',
          created_at: task.created_at,
          updated_at: task.updated_at,
          custom_data: { type: 'task', task }
        }))
      );

      const taskIds = tasks.map((t: any) => t.id);
      const { data: comments, error: commentsError } = await supabaseAdmin
        .from('task_comments')
        .select('id, task_id, content, created_at, updated_at, is_private, attachments, files')
        .in('task_id', taskIds)
        .eq('is_private', false)
        .order('created_at', { ascending: true });

      if (!commentsError && comments?.length) {
        const taskCommentMessages = comments
          .filter((c: any) => !c.is_private)
          .map((c: any) => {
            const fileUrls: string[] = [];
            const filesPayload = c.files;
            if (Array.isArray(filesPayload)) {
              for (const f of filesPayload) {
                if (typeof f === 'string' && /^https?:\/\//i.test(f)) fileUrls.push(f);
                else if (f && typeof f === 'object' && typeof (f as any).url === 'string') fileUrls.push((f as any).url);
              }
            } else if (filesPayload && typeof filesPayload === 'object' && typeof (filesPayload as any).url === 'string') {
              fileUrls.push((filesPayload as any).url);
            } else if (typeof filesPayload === 'string' && /^https?:\/\//i.test(filesPayload)) {
              fileUrls.push(filesPayload);
            }
            const contentWithUrls = fileUrls.length > 0 ? `${c.content}\n${fileUrls.join('\n')}` : c.content;
            const adjustedCreatedAt = new Date(new Date(c.created_at).getTime() - 10 * 1000).toISOString();
            return {
              id: `task_comment-${c.id}`,
              conversation_id: conversationId,
              content: contentWithUrls,
              role: 'user',
              created_at: adjustedCreatedAt,
              updated_at: c.updated_at,
              custom_data: { type: 'task_comment', task_id: c.task_id, attachments: c.attachments, files: c.files }
            };
          });
        syntheticMessages.push(...taskCommentMessages);
      }
    }
  } catch (_e) {
    // continue without synthetic messages
  }

  const mergedMessages = [...(messages || []), ...syntheticMessages]
    .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const total = count ?? 0;
  const pages = Math.ceil(total / safeLimit);

  return {
    success: true,
    data: {
      messages: mergedMessages,
      pagination: { total, page: Math.floor(offset / safeLimit) + 1, limit: safeLimit, pages }
    }
  };
}
