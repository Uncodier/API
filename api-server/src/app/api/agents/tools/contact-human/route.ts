import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { 
  NotificationService, 
  NotificationType, 
  NotificationPriority 
} from '@/lib/services/notification-service';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Función para obtener los destinatarios de correo según la solicitud
 * @param siteId ID del sitio donde se origina la solicitud
 * @returns Lista de correos electrónicos de los administradores del sitio
 */
async function getEmailRecipients(siteId: string): Promise<string[]> {
  try {
    // Obtener los administradores del sitio
    const { data: admins, error } = await supabaseAdmin
      .from('site_users')
      .select('user_id')
      .eq('site_id', siteId)
      .eq('role', 'admin');
    
    if (error || !admins || admins.length === 0) {
      console.warn('No se encontraron administradores para el sitio:', siteId);
      return [];
    }
    
    // Extraer los IDs de usuario
    const userIds = admins.map(admin => admin.user_id);
    
    // Obtener los correos de los usuarios
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select('email')
      .in('id', userIds);
    
    if (usersError || !users || users.length === 0) {
      console.warn('No se encontraron usuarios con los IDs:', userIds);
      return [];
    }
    
    // Extraer los correos electrónicos
    return users.map(user => user.email).filter(Boolean);
  } catch (error) {
    console.error('Error al obtener destinatarios de correo:', error);
    return [];
  }
}

/**
 * Función para generar el contenido HTML del correo
 * @param interventionData Datos de la intervención
 * @param conversationData Datos de la conversación
 * @param agentData Datos del agente (opcional)
 * @param summary Resumen de la conversación o contexto adicional
 * @returns Contenido HTML del correo
 */
function generateEmailHtml(
  interventionData: any,
  conversationData: any,
  agentData: any | null,
  summary?: string
): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
  const conversationUrl = `${baseUrl}/sites/${conversationData.site_id}/conversations/${conversationData.id}`;
  
  const agentText = agentData ? `El agente <strong>${agentData.name}</strong> ha` : "Se ha";
  
  // Verificar si hay datos de contacto
  const hasContactInfo = interventionData.contact_name || interventionData.contact_email;
  
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      <h2 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">Solicitud de intervención humana</h2>
      
      <p style="margin: 20px 0; font-size: 16px;">
        ${agentText} solicitado la intervención de un humano 
        en una conversación con prioridad <strong>${interventionData.priority}</strong>.
      </p>
      
      <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #6366f1; margin: 20px 0;">
        <p style="margin: 0; font-style: italic;">"${interventionData.message}"</p>
      </div>
      
      ${summary ? `
      <h3 style="margin-top: 25px; color: #444;">Resumen de la conversación:</h3>
      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; margin: 15px 0;">
        <p style="margin: 0;">${summary}</p>
      </div>
      ` : ''}
      
      ${hasContactInfo ? `
      <h3 style="margin-top: 25px; color: #444;">Información de contacto:</h3>
      <div style="background-color: #f0f7ff; padding: 15px; border-radius: 4px; margin: 15px 0;">
        ${interventionData.contact_name ? `<p><strong>Nombre:</strong> ${interventionData.contact_name}</p>` : ''}
        ${interventionData.contact_email ? `<p><strong>Email:</strong> <a href="mailto:${interventionData.contact_email}">${interventionData.contact_email}</a></p>` : ''}
      </div>
      ` : ''}
      
      <h3 style="margin-top: 25px; color: #444;">Detalles de la solicitud:</h3>
      <ul style="padding-left: 20px;">
        <li><strong>ID de intervención:</strong> ${interventionData.id}</li>
        <li><strong>Conversación:</strong> ${conversationData.title || 'Sin título'}</li>
        <li><strong>Fecha de solicitud:</strong> ${new Date(interventionData.requested_at).toLocaleString()}</li>
        <li><strong>Estado:</strong> Pendiente</li>
      </ul>
      
      <div style="margin: 30px 0; text-align: center;">
        <a href="${conversationUrl}" style="display: inline-block; background-color: #6366f1; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Ver conversación
        </a>
      </div>
      
      <p style="color: #777; font-size: 14px; margin-top: 40px;">
        Este correo fue generado automáticamente. Por favor, no responda a este mensaje.
      </p>
    </div>
  `;
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
      site_id: siteId,
      lead_id: conversationData.lead_id,
      visitor_id: conversationData.visitor_id,
      metadata: {
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
    
    // Obtener correos de los administradores del sitio
    const emailRecipients = await getEmailRecipients(siteId);
    
    // Crear título y mensaje para la notificación
    const notificationTitle = `Intervención humana solicitada${agent_id ? ` por ${agentData?.name || 'Agente no especificado'}` : ''}`;
    const notificationMessage = `Se requiere intervención humana en una conversación. Mensaje: "${message}"`;
    
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

    // Notificar a través del servicio de notificaciones
    if (emailRecipients.length > 0) {
      // Para el email, podemos simular los datos de intervención
      const interventionData = {
        id: interventionId,
        conversation_id,
        agent_id: agent_id || null,
        message,
        priority,
        status: 'pending',
        user_id: conversationData.user_id,
        requested_at: new Date().toISOString(),
        requested_by: agent_id ? 'agent' : 'system',
        site_id: siteId,
        lead_id: conversationData.lead_id,
        visitor_id: conversationData.visitor_id,
        summary: summary || null,
        contact_name: name || null,
        contact_email: email || null
      };
      
      // Generar el HTML para el correo
      const emailHtml = generateEmailHtml(
        interventionData,
        conversationData,
        agentData,
        summary
      );
      
      // Enviar notificación y correo
      await NotificationService.notify(
        {
          user_id: conversationData.user_id,
          site_id: siteId,
          title: notificationTitle,
          message: notificationMessage,
          type: NotificationType.HUMAN_INTERVENTION,
          priority: notificationPriority,
          entity_type: 'conversation',
          entity_id: conversation_id,
          metadata: notificationMetadata
        },
        {
          to: emailRecipients,
          subject: notificationTitle,
          html: emailHtml,
          text: `${notificationMessage} Accede a la plataforma para revisar la conversación.`
        }
      );
    } else {
      // Solo crear notificación en el sistema si no hay destinatarios de correo
      await NotificationService.createNotification({
        user_id: conversationData.user_id,
        site_id: siteId,
        title: notificationTitle,
        message: notificationMessage,
        type: NotificationType.HUMAN_INTERVENTION,
        priority: notificationPriority,
        entity_type: 'conversation',
        entity_id: conversation_id,
        metadata: notificationMetadata
      });
    }
    
    // Respuesta exitosa con los datos de la intervención
    return NextResponse.json(
      {
        success: true,
        intervention_id: interventionId,
        conversation_id,
        agent_id: agent_id || null,
        status: 'pending',
        message: {
          content: message,
          priority
        },
        summary: summary || null,
        contact_name: name || null,
        contact_email: email || null,
        requested_at: new Date().toISOString()
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
    
    // Consulta base (ahora consultamos la tabla de notificaciones)
    let query = supabaseAdmin
      .from('notifications')
      .select('id, title, message, type, site_id, user_id, created_at, related_entity_id, metadata')
      .eq('type', NotificationType.HUMAN_INTERVENTION);
    
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
      // Filtramos por el ID de intervención en los metadatos
      query = query.contains('metadata', { intervention_id: interventionId });
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
      // Filtramos por el ID de conversación en el campo entity_id
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
      const metadata = notification.metadata || {};
      return {
        id: metadata.intervention_id || notification.id,
        conversation_id: notification.related_entity_id,
        agent_id: metadata.agent_id || null,
        message: notification.message,
        priority: metadata.priority || 'normal',
        status: 'pending', // Las notificaciones no tienen estado, asumimos pending
        requested_at: notification.created_at,
        resolved_at: null,
        resolved_by: null,
        summary: metadata.summary || null,
        contact_name: metadata.contact_name || null,
        contact_email: metadata.contact_email || null
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