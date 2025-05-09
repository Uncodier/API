import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Endpoint para delegar una conversación a un agente específico basado en un rol
 * 
 * @param request Solicitud entrante con los datos necesarios para la delegación
 * @returns Respuesta con el estado de la delegación
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { conversation_id, agent_role } = body;
    
    // Validar parámetros requeridos
    if (!conversation_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'conversation_id is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(conversation_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'conversation_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!agent_role) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'agent_role is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Verificar que la conversación existe
    const { data: conversationData, error: conversationError } = await supabaseAdmin
      .from('conversations')
      .select('id, user_id, site_id, lead_id, visitor_id')
      .eq('id', conversation_id)
      .single();
    
    if (conversationError || !conversationData) {
      console.error('Error al verificar la conversación:', conversationError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'CONVERSATION_NOT_FOUND', 
            message: 'The specified conversation was not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Buscar el agente con el rol especificado en el sitio de la conversación
    const { data: agentData, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, name, role')
      .eq('role', agent_role)
      .eq('site_id', conversationData.site_id)
      .single();
    
    if (agentError || !agentData) {
      console.error('Error al encontrar el agente con el rol especificado:', agentError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'AGENT_NOT_FOUND', 
            message: `No agent found with role '${agent_role}' in the conversation's site` 
          } 
        },
        { status: 404 }
      );
    }
    
    // Verificar si la conversación ya tiene un delegado
    const { data: existingDelegate, error: delegateError } = await supabaseAdmin
      .from('conversations')
      .select('delegate_id')
      .eq('id', conversation_id)
      .single();
    
    // Estado para la respuesta
    let statusCode = 200;
    let responseMessage = 'Conversation delegated successfully';
    
    if (!delegateError && existingDelegate && existingDelegate.delegate_id) {
      if (existingDelegate.delegate_id === agentData.id) {
        // El delegado ya está asignado al mismo agente
        statusCode = 204;
        responseMessage = 'Agent already assigned as delegate';
      } else {
        // Se está cambiando el delegado
        statusCode = 200;
        responseMessage = 'Delegate updated successfully';
      }
    } else {
      // Nuevo delegado asignado
      statusCode = 201;
      responseMessage = 'New delegate assigned successfully';
    }
    
    // Actualizar la conversación con el nuevo delegado
    const { error: updateError } = await supabaseAdmin
      .from('conversations')
      .update({ 
        delegate_id: agentData.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation_id);
    
    if (updateError) {
      console.error('Error al actualizar el delegado de la conversación:', updateError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'UPDATE_FAILED', 
            message: 'Failed to update conversation delegate' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Añadir un mensaje de sistema en la conversación indicando la delegación
    const systemMessageData = {
      conversation_id,
      content: `La conversación ha sido delegada al agente con rol "${agent_role}" (${agentData.name}).`,
      role: 'system',
      agent_id: agentData.id,
      user_id: conversationData.user_id,
      site_id: conversationData.site_id,
      lead_id: conversationData.lead_id,
      visitor_id: conversationData.visitor_id,
      metadata: {
        delegation: {
          agent_role,
          agent_id: agentData.id,
          agent_name: agentData.name
        }
      }
    };
    
    const { error: messageError } = await supabaseAdmin
      .from('messages')
      .insert([systemMessageData]);
    
    if (messageError) {
      console.error('Error al guardar el mensaje de sistema:', messageError);
      // No fallamos toda la operación si solo falla el mensaje
      console.log('Continuando con la respuesta de la API...');
    }
    
    // Respuesta exitosa con los datos de la delegación
    return NextResponse.json(
      {
        success: true,
        conversation_id,
        delegate_id: agentData.id,
        message: responseMessage
      },
      { status: statusCode }
    );
    
  } catch (error) {
    console.error('Error al procesar la solicitud de delegación:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An error occurred while processing the delegation request' 
        } 
      },
      { status: 500 }
    );
  }
}

/**
 * Endpoint para obtener información sobre la delegación de una conversación
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversation_id');
    
    // Validar el ID de conversación
    if (!conversationId) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'conversation_id is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(conversationId)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'conversation_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Primero, obtener los datos básicos de la conversación
    const { data: conversationData, error: conversationError } = await supabaseAdmin
      .from('conversations')
      .select('id, title, user_id, site_id, delegate_id')
      .eq('id', conversationId)
      .single();
    
    if (conversationError) {
      console.error('Error al obtener información de la conversación:', conversationError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'Failed to retrieve conversation data' 
          } 
        },
        { status: 500 }
      );
    }
    
    if (!conversationData) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NOT_FOUND', 
            message: 'Conversation not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Verificar si hay un delegado asignado
    if (!conversationData.delegate_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_DELEGATE', 
            message: 'No delegate assigned to this conversation' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Obtener los datos del agente delegado
    const { data: delegateData, error: delegateError } = await supabaseAdmin
      .from('agents')
      .select('id, name, role, description')
      .eq('id', conversationData.delegate_id)
      .single();
    
    if (delegateError || !delegateData) {
      console.error('Error al obtener información del agente delegado:', delegateError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DELEGATE_NOT_FOUND', 
            message: 'Delegate agent information not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Devolver los datos de la delegación
    return NextResponse.json(
      {
        success: true,
        conversation_id: conversationData.id,
        delegate_id: conversationData.delegate_id,
        delegate: delegateData
      },
      { status: 200 }
    );
    
  } catch (error) {
    console.error('Error al consultar la delegación de la conversación:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An error occurred while retrieving the delegation information' 
        } 
      },
      { status: 500 }
    );
  }
} 