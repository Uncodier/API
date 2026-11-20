import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationType } from '@/lib/services/notification-service';
import { isValidUUID } from './intervention-operations';

export async function getInterventionStatus(request: NextRequest) {
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

    // Consulta base (ahora consultamos la tabla de notificaciones)
    let query = supabaseAdmin
      .from('notifications')
      .select('id, title, message, type, site_id, user_id, created_at, related_entity_id')
      .eq('type', NotificationType.WARNING);

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
      // Filtrar por el ID directamente (ya que no tenemos metadata)
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
      // Filtramos por el ID de conversación en el campo related_entity_id
      query = query.eq('related_entity_id', conversationId);
    }

    // Ejecutar la consulta
    const { data, error } = await query;

    if (error) {
      console.error('Error al consultar las notificaciones de intervención:', error);
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

    // Transformar los datos de las notificaciones al formato esperado de intervenciones
    const interventions = data.map(notification => {
      return {
        id: notification.id,
        conversation_id: notification.related_entity_id,
        agent_id: null, // No metadata available
        message: notification.message,
        priority: 'normal', // Default since no metadata
        status: 'pending', // Las notificaciones no tienen estado, asumimos pending
        requested_at: notification.created_at,
        resolved_at: null,
        resolved_by: null,
        summary: null, // No metadata available
        contact_name: null, // No metadata available
        contact_email: null // No metadata available
      };
    });

    // Devolver los datos transformados
    return NextResponse.json(
      {
        success: true,
        interventions: interventions
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
