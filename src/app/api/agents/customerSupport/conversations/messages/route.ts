import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function GET(request: Request) {
  try {
    // Extract query parameters from the URL
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversation_id');
    const siteId = url.searchParams.get('site_id');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const debug = url.searchParams.get('debug') === 'true';

    console.log(`🔍 Buscando mensajes para la conversación: conversation_id=${conversationId || 'N/A'}, site_id=${siteId || 'N/A'}`);

    // Validate input parameters
    if (!conversationId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'conversation_id is required' } },
        { status: 400 }
      );
    }

    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
        { status: 400 }
      );
    }

    // Validate UUID format for provided parameters
    if (!isValidUUID(conversationId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'conversation_id must be a valid UUID' } },
        { status: 400 }
      );
    }

    if (!isValidUUID(siteId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }

    // First, verify that the conversation exists and belongs to the specified site
    const { data: conversation, error: conversationError } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('site_id', siteId)
      .single();

    if (conversationError) {
      console.error('Error al verificar la conversación:', conversationError);
      return NextResponse.json(
        { success: false, error: { code: 'DATABASE_ERROR', message: 'Error verifying conversation', details: debug ? conversationError : undefined } },
        { status: 500 }
      );
    }

    if (!conversation) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found or does not belong to the specified site' } },
        { status: 404 }
      );
    }

    // Query the messages
    const { data: messages, error: messagesError, count } = await supabaseAdmin
      .from('messages')
      .select('*', { count: 'exact' })
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (messagesError) {
      console.error('Error al consultar mensajes:', messagesError);
      return NextResponse.json(
        { success: false, error: { code: 'DATABASE_ERROR', message: 'Error querying messages', details: debug ? messagesError : undefined } },
        { status: 500 }
      );
    }

    // Fetch tasks related to this conversation and site
    let syntheticMessages: any[] = [];
    try {
      const { data: tasks, error: tasksError } = await supabaseAdmin
        .from('tasks')
        .select(`
          id,
          title,
          description,
          type,
          status,
          stage,
          priority,
          user_id,
          site_id,
          conversation_id,
          created_at,
          updated_at,
          assignee,
          serial_id,
          address
        `)
        .eq('conversation_id', conversationId)
        .eq('site_id', siteId)
        .order('created_at', { ascending: true });

      if (tasksError) {
        console.warn('⚠️ Error al consultar tasks (se continuará sin tasks):', tasksError.message);
      } else if (tasks && tasks.length > 0) {
        // Build synthetic task messages
        const taskCreatedMessages = tasks.map((task: any) => ({
          id: `task-${task.id}`,
          conversation_id: conversationId,
          content: `Task created: ${task.title}${task.description ? ` — ${task.description}` : ''}`,
          role: 'system',
          created_at: task.created_at,
          updated_at: task.updated_at,
          custom_data: {
            type: 'task',
            task
          }
        }));

        syntheticMessages.push(...taskCreatedMessages);

        // Fetch public comments for these tasks
        const taskIds = tasks.map((t: any) => t.id);
        if (taskIds.length > 0) {
          const { data: comments, error: commentsError } = await supabaseAdmin
            .from('task_comments')
            .select(`
              id,
              task_id,
              content,
              created_at,
              updated_at,
              is_private,
              attachments,
              files
            `)
            .in('task_id', taskIds)
            .eq('is_private', false)
            .order('created_at', { ascending: true });

          if (commentsError) {
            console.warn('⚠️ Error al consultar task_comments (se continuará sin comentarios):', commentsError.message);
          } else if (comments && comments.length > 0) {
            const taskCommentMessages = comments.map((c: any) => ({
              id: `task_comment-${c.id}`,
              conversation_id: conversationId,
              content: c.content,
              role: 'team_member',
              created_at: c.created_at,
              updated_at: c.updated_at,
              custom_data: {
                type: 'task_comment',
                task_id: c.task_id,
                attachments: c.attachments,
                files: c.files
              }
            }));
            syntheticMessages.push(...taskCommentMessages);
          }
        }
      }
    } catch (e: any) {
      console.warn('⚠️ Error inesperado agregando tasks como mensajes (se continuará sin tasks):', e?.message || e);
    }

    // Merge and sort messages + synthetic task messages by created_at ascending
    const mergedMessages = [...(messages || []), ...syntheticMessages]
      .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Calculate pagination (based on real messages only to avoid breaking clients)
    const total = count || 0;
    const pages = Math.ceil(total / limit);

    console.log(`✅ Se encontraron ${messages.length} mensajes y ${syntheticMessages.length} eventos de tareas para la conversación ${conversationId}`);

    return NextResponse.json(
      {
        success: true,
        data: {
          messages: mergedMessages,
          pagination: {
            total,
            page: Math.floor(offset / limit) + 1,
            limit,
            pages
          }
        },
        debug: debug ? { query_params: { conversationId, siteId }, synthetic_counts: { tasks: syntheticMessages.filter(m => String(m.id).startsWith('task-')).length, task_comments: syntheticMessages.filter(m => String(m.id).startsWith('task_comment-')).length } } : undefined
      }
    );
  } catch (error) {
    console.error('Error en endpoint de mensajes de conversación:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 