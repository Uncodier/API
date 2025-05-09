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

    // Calculate pagination
    const total = count || 0;
    const pages = Math.ceil(total / limit);

    console.log(`✅ Se encontraron ${messages.length} mensajes para la conversación ${conversationId}`);

    return NextResponse.json(
      { 
        success: true, 
        data: { 
          messages: messages || [], 
          pagination: { 
            total, 
            page: Math.floor(offset / limit) + 1, 
            limit, 
            pages 
          } 
        },
        debug: debug ? { query_params: { conversationId, siteId } } : undefined
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