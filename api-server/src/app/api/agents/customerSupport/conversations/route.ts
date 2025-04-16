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
    const leadId = url.searchParams.get('lead_id');
    const visitorId = url.searchParams.get('visitor_id');
    const userId = url.searchParams.get('user_id');
    const siteId = url.searchParams.get('site_id');
    const agentId = url.searchParams.get('agent_id');
    const limit = parseInt(url.searchParams.get('limit') || '10');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const debug = url.searchParams.get('debug') === 'true';

    console.log(`🔍 Buscando conversaciones con parámetros: lead_id=${leadId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, user_id=${userId || 'N/A'}, site_id=${siteId || 'N/A'}, agent_id=${agentId || 'N/A'}`);

    // Validate input parameters
    if (!leadId && !visitorId && !userId && !siteId && !agentId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'At least one of lead_id, visitor_id, user_id, site_id, or agent_id is required' } },
        { status: 400 }
      );
    }

    // Validate UUID format for provided parameters
    if (leadId && !isValidUUID(leadId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'lead_id must be a valid UUID' } },
        { status: 400 }
      );
    }

    if (visitorId && !isValidUUID(visitorId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'visitor_id must be a valid UUID' } },
        { status: 400 }
      );
    }

    if (userId && !isValidUUID(userId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'user_id must be a valid UUID' } },
        { status: 400 }
      );
    }

    // Validate site_id if provided
    if (siteId && !isValidUUID(siteId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Validate agent_id if provided
    if (agentId && !isValidUUID(agentId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'agent_id must be a valid UUID' } },
        { status: 400 }
      );
    }

    // Build the base query
    let query = supabaseAdmin
      .from('conversations')
      .select(`
        *,
        messages:messages(
          content, 
          role, 
          created_at,
          id
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Add filters based on provided parameters
    if (leadId) {
      query = query.eq('lead_id', leadId);
    }

    if (visitorId) {
      query = query.eq('visitor_id', visitorId);
    }

    if (userId) {
      query = query.eq('user_id', userId);
    }

    if (siteId) {
      query = query.eq('site_id', siteId);
    }
    
    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    console.log(`🔍 Ejecutando consulta de conversaciones...`);
    const { data, error, count } = await query;

    if (error) {
      console.error('Error al consultar conversaciones:', error);
      return NextResponse.json(
        { success: false, error: { code: 'DATABASE_ERROR', message: 'Error querying conversations', details: debug ? error : undefined } },
        { status: 500 }
      );
    }

    if (!data || data.length === 0) {
      console.log(`ℹ️ No se encontraron conversaciones para los parámetros proporcionados`);
      return NextResponse.json(
        { 
          success: true, 
          data: { 
            conversations: [], 
            pagination: { 
              total: 0, 
              page: Math.floor(offset / limit) + 1, 
              limit, 
              pages: 0 
            } 
          },
          debug: debug ? { query_params: { leadId, visitorId, userId, siteId, agentId } } : undefined
        }
      );
    }

    // Process the conversations: order messages and calculate last message time
    const processedConversations = data.map(conversation => {
      // Sort messages by created_at
      const sortedMessages = conversation.messages 
        ? [...conversation.messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        : [];
      
      const lastMessage = sortedMessages.length > 0 ? sortedMessages[sortedMessages.length - 1] : null;
      
      return {
        ...conversation,
        messages: sortedMessages,
        last_message: lastMessage,
        message_count: sortedMessages.length
      };
    });

    console.log(`✅ Se encontraron ${processedConversations.length} conversaciones`);
    
    if (debug) {
      console.log(`📊 Primera conversación: ${JSON.stringify(processedConversations[0])}`);
    }

    // Calculate pagination
    const total = count || 0;
    const pages = Math.ceil(total / limit);

    return NextResponse.json(
      { 
        success: true, 
        data: { 
          conversations: processedConversations, 
          pagination: { 
            total, 
            page: Math.floor(offset / limit) + 1, 
            limit, 
            pages 
          } 
        },
        debug: debug ? { query_params: { leadId, visitorId, userId, siteId, agentId } } : undefined
      }
    );
  } catch (error) {
    console.error('Error en endpoint de conversaciones:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 