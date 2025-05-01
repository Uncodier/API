import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Endpoint para solicitar la intervención de un humano en una conversación
 * 
 * @param request Solicitud entrante con los datos necesarios para contactar a un humano
 * @returns Respuesta con el estado de la solicitud y los datos de la intervención
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { 
      conversation_id, 
      agent_id, 
      message, 
      priority = 'normal',
      user_id
    } = body;
    
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
    
    if (!agent_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'agent_id is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(agent_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'agent_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!message) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'message is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Verificar que la conversación existe
    const { data: conversationData, error: conversationError } = await supabaseAdmin
      .from('conversations')
      .select('id, user_id, title, site_id, lead_id, visitor_id')
      .eq('id', conversation_id)
      .single();
    
    if (conversationError) {
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
    
    // Verificar que el agente existe
    const { data: agentData, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, name, site_id')
      .eq('id', agent_id)
      .single();
    
    if (agentError) {
      console.error('Error al verificar el agente:', agentError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'AGENT_NOT_FOUND', 
            message: 'The specified agent was not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Crear un registro de solicitud de intervención humana
    const interventionId = uuidv4();
    const interventionRequestData = {
      id: interventionId,
      conversation_id,
      agent_id,
      message,
      priority,
      status: 'pending', // Las solicitudes siempre comienzan en estado pendiente
      user_id: conversationData.user_id,
      requested_at: new Date().toISOString(),
      requested_by: 'agent', // Indicando que la solicitud viene del agente
      site_id: conversationData.site_id || agentData.site_id,
      lead_id: conversationData.lead_id,
      visitor_id: conversationData.visitor_id
    };
    
    const { data: intervention, error: interventionError } = await supabaseAdmin
      .from('human_interventions')
      .insert([interventionRequestData])
      .select()
      .single();
    
    if (interventionError) {
      console.error('Error al crear la solicitud de intervención:', interventionError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INTERVENTION_CREATION_FAILED', 
            message: 'Failed to create the human intervention request' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Guardar un mensaje en la conversación indicando la solicitud de intervención
    const systemMessageData = {
      conversation_id,
      content: `El agente ha solicitado la intervención de un humano con el siguiente mensaje: "${message}"`,
      role: 'system',
      agent_id,
      user_id: conversationData.user_id,
      site_id: conversationData.site_id || agentData.site_id,
      lead_id: conversationData.lead_id,
      visitor_id: conversationData.visitor_id,
      metadata: {
        intervention_id: interventionId,
        priority
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
    
    // Respuesta exitosa con los datos de la intervención
    return NextResponse.json(
      {
        success: true,
        intervention_id: interventionId,
        conversation_id,
        agent_id,
        status: 'pending',
        message: {
          content: message,
          priority
        },
        requested_at: interventionRequestData.requested_at
      },
      { status: 201 }
    );
    
  } catch (error) {
    console.error('Error al procesar la solicitud de contacto humano:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An error occurred while processing the contact human request' 
        } 
      },
      { status: 500 }
    );
  }
}

/**
 * Endpoint para obtener el estado de una solicitud de intervención
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const interventionId = url.searchParams.get('intervention_id');
    const conversationId = url.searchParams.get('conversation_id');
    
    // Validar que tenemos al menos uno de los parámetros
    if (!interventionId && !conversationId) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'Either intervention_id or conversation_id must be provided' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Consulta base
    let query = supabaseAdmin
      .from('human_interventions')
      .select('id, conversation_id, agent_id, message, priority, status, requested_at, resolved_at, resolved_by');
    
    // Filtrar por ID de intervención o conversación
    if (interventionId) {
      if (!isValidUUID(interventionId)) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'INVALID_REQUEST', 
              message: 'intervention_id must be a valid UUID' 
            } 
          },
          { status: 400 }
        );
      }
      query = query.eq('id', interventionId);
    } else if (conversationId) {
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
      query = query.eq('conversation_id', conversationId);
    }
    
    // Ejecutar la consulta
    const { data, error } = await query;
    
    if (error) {
      console.error('Error al consultar las intervenciones:', error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'Failed to retrieve intervention data' 
          } 
        },
        { status: 500 }
      );
    }
    
    if (!data || data.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NOT_FOUND', 
            message: 'No intervention requests found with the specified criteria' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Devolver los datos de la intervención
    return NextResponse.json(
      {
        success: true,
        interventions: data
      },
      { status: 200 }
    );
    
  } catch (error) {
    console.error('Error al consultar la solicitud de contacto humano:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An error occurred while retrieving the contact human request' 
        } 
      },
      { status: 500 }
    );
  }
} 