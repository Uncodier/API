import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationService, NotificationType } from '@/lib/services/notification-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { VisitorNotificationService } from '@/lib/services/visitor-notification-service';
import { v4 as uuidv4 } from 'uuid';
import { 
  NotificationPriority 
} from '@/lib/services/notification-service';

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
 * 
 * Parámetros de la solicitud:
 * - conversation_id: (Requerido) ID de la conversación donde se solicita la intervención
 * - message: (Requerido) Mensaje explicativo para el humano que intervendrá
 * - agent_id: (Opcional) ID del agente que realiza la solicitud
 * - priority: (Opcional) Prioridad de la solicitud (low, normal, high, urgent). Por defecto: 'normal'
 * - summary: (Opcional) Resumen de la conversación o contexto adicional
 * - name: (Opcional) Nombre de la persona de contacto
 * - email: (Opcional) Correo electrónico de la persona de contacto
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
      user_id,
      summary,
      name,
      email
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
    
    if (agent_id && !isValidUUID(agent_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'agent_id must be a valid UUID when provided' 
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
    
    // Variables para almacenar datos del agente
    let agentData = null;
    
    // Verificar que el agente existe, solo si se proporcionó un agent_id
    if (agent_id) {
      const { data: agent, error: agentError } = await supabaseAdmin
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
      
      agentData = agent;
    }
    
    // Generar un ID para la intervención (solo para referencia)
    const interventionId = uuidv4();
    const siteId = conversationData.site_id || agentData?.site_id;
    
    // Guardar un mensaje en la conversación indicando la solicitud de intervención
    const systemMessageData = {
      conversation_id,
      content: `${agent_id ? 'El agente ha' : 'Se ha'} solicitado la intervención de un humano con el siguiente mensaje: "${message}"`,
      role: 'system',
      agent_id,
      user_id: conversationData.user_id,
      lead_id: conversationData.lead_id,
      visitor_id: conversationData.visitor_id,
      custom_data: {
        intervention_id: interventionId,
        priority,
        summary
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
    
    // Crear notificación en el sistema
    let notificationPriority;
    switch (priority) {
      case 'high':
        notificationPriority = NotificationPriority.HIGH;
        break;
      case 'urgent':
        notificationPriority = NotificationPriority.URGENT;
        break;
      case 'low':
        notificationPriority = NotificationPriority.LOW;
        break;
      default:
        notificationPriority = NotificationPriority.NORMAL;
    }
    
    // Crear objeto de metadatos para la notificación
    const notificationMetadata = {
      intervention_id: interventionId,
      priority,
      agent_id,
      agent_name: agentData?.name || 'Agente no especificado',
      summary: summary || null,
      contact_name: name || null,
      contact_email: email || null
    };

    // Usar el nuevo servicio de notificación al equipo
    const teamNotificationResult = await TeamNotificationService.notifyHumanIntervention({
      siteId,
      conversationId: conversation_id,
      message,
      priority,
      agentName: agentData?.name,
      summary,
      contactName: name,
      contactEmail: email
    });

    // Obtener lista de correos de los miembros notificados
    const teamMembers = await TeamNotificationService.getTeamMembersWithEmailNotifications(siteId);
    const notifiedEmails = teamMembers.map(member => member.email);

    if (!teamNotificationResult.success) {
      console.error('Error al notificar al equipo:', teamNotificationResult.errors);
    } else {
      console.log(`Equipo notificado exitosamente: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
      
      // Si la notificación al equipo fue exitosa y tenemos email del visitante, notificar al visitante
      if (email) {
        console.log(`📧 Enviando confirmación al visitante: ${email}`);
        
        const visitorNotificationResult = await VisitorNotificationService.notifyMessageReceived({
          visitorEmail: email,
          visitorName: name,
          message,
          agentName: agentData?.name,
          summary,
          supportEmail: process.env.SUPPORT_EMAIL || 'support@uncodie.com'
        });
        
        if (visitorNotificationResult.success) {
          console.log(`✅ Visitante notificado exitosamente: ${email}`);
        } else {
          console.error(`❌ Error al notificar al visitante ${email}:`, visitorNotificationResult.error);
        }
      }
    }
    
    // Respuesta exitosa con los datos de la intervención
    return NextResponse.json({
      success: true,
      data: {
        intervention_id: interventionId,
        conversation_id,
        message,
        priority,
        status: 'pending',
        created_at: new Date().toISOString(),
        summary,
        contact_name: name,
        contact_email: email,
        team_notification: {
          notifications_sent: teamNotificationResult.notificationsSent,
          emails_sent: teamNotificationResult.emailsSent,
          notified_emails: notifiedEmails,
          total_members: teamNotificationResult.totalMembers
        },
        visitor_notification: {
          sent: !!email && teamNotificationResult.success,
          email: email || null
        }
      }
    }, { status: 201 });
    
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