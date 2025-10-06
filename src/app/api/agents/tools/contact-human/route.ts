import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationType } from '@/lib/services/notification-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { VisitorNotificationService } from '@/lib/services/visitor-notification-service';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { 
  NotificationPriority 
} from '@/lib/services/notification-service';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Crea un task de soporte para el lead asociado a la conversación
 */
async function createSupportTask(
  conversationId: string, 
  leadId: string | null, 
  siteId: string, 
  userId: string,
  message: string,
  summary?: string,
  contactName?: string,
  priorityInput?: 'low' | 'normal' | 'high' | 'urgent' | number
): Promise<string | null> {
  try {
    if (!leadId) {
      console.log('No se puede crear task de soporte: no hay lead asociado a la conversación');
      return null;
    }

    console.log(`📋 Creando task de soporte para lead: ${leadId}`);
    
    // Obtener información del lead para usar en el task
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email')
      .eq('id', leadId)
      .maybeSingle();
    
    if (leadError) {
      // Permitir continuar si el error es por no encontrar filas (PGRST116)
      if (leadError.code && leadError.code !== 'PGRST116') {
        console.error('Error al obtener información del lead para el task:', leadError);
        return null;
      }
    }
    
    // Generar un serial_id determinístico para idempotencia de esta solicitud
    const hashInput = `${conversationId}|${leadId}|${(message || '').slice(0, 200)}|${summary || ''}`;
    const serialId = `SUPPORT-${createHash('sha256').update(hashInput).digest('hex').slice(0, 24)}`;

    // Dedupe 1: verificar por serial_id existente
    const { data: existingBySerial, error: existingSerialError } = await supabaseAdmin
      .from('tasks')
      .select('id, serial_id, created_at')
      .eq('serial_id', serialId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!existingSerialError && existingBySerial && existingBySerial.length > 0) {
      const existing = existingBySerial[0];
      console.log(`🔁 Task de soporte ya existe por serial_id (${existing.serial_id}): ${existing.id}`);
      return existing.id;
    }

    // Dedupe 2: verificar por conversación/tipo/estado reciente (protege contra reintentos sin mismo payload)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentTasks, error: recentError } = await supabaseAdmin
      .from('tasks')
      .select('id, created_at, type, status, conversation_id, lead_id')
      .eq('conversation_id', conversationId)
      .eq('lead_id', leadId)
      .eq('type', 'support')
      .in('status', ['pending', 'active'])
      .gte('created_at', tenMinutesAgo)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!recentError && recentTasks && recentTasks.length > 0) {
      console.log(`🔁 Task de soporte duplicado detectado en ventana reciente, reutilizando ${recentTasks[0].id}`);
      return recentTasks[0].id;
    }

    // Preparar datos para el task
    const taskTitleName = contactName || lead?.name || 'Lead';
    // Map incoming priority to numeric; default to low (0)
    const priorityMap: Record<string, number> = {
      low: 0,
      normal: 1,
      high: 10,
      urgent: 15
    };
    const normalizedPriority = (() => {
      if (typeof priorityInput === 'number' && Number.isFinite(priorityInput)) {
        return priorityInput;
      }
      if (typeof priorityInput === 'string') {
        const key = priorityInput.toLowerCase();
        if (key in priorityMap) return priorityMap[key];
        const parsed = parseInt(priorityInput, 10);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return 0; // low default
    })();

    const taskData = {
      lead_id: leadId,
      conversation_id: conversationId,
      title: `Soporte solicitado - ${taskTitleName}`,
      description: `Tarea de soporte creada automáticamente cuando el usuario solicitó ayuda humana.\n\nMensaje del usuario: "${message}"${summary ? `\n\nResumen de la conversación: ${summary}` : ''}`,
      type: 'support',
      stage: 'retention',
      status: 'pending',
      priority: normalizedPriority,
      user_id: userId,
      site_id: siteId,
      scheduled_date: new Date().toISOString(),
      notes: `Intervención humana solicitada. Conversación ID: ${conversationId}`,
      serial_id: serialId
    };
    
    console.log(`📋 Datos para el task de soporte:`, JSON.stringify(taskData));
    
    // Insertar el task en la base de datos
    const { data: task, error: taskError } = await supabaseAdmin
      .from('tasks')
      .insert([taskData])
      .select()
      .maybeSingle();
    
    if (taskError) {
      console.error('Error al crear task de soporte:', taskError);
      return null;
    }
    
    console.log(`✅ Task de soporte creado exitosamente: ${task.id}`);
    return task.id;
    
  } catch (error) {
    console.error('Error inesperado al crear task de soporte:', error);
    return null;
  }
}

/**
 * Función para enviar respuesta automática via WhatsApp 
 */
async function sendWhatsAppAutoResponse(
  conversationData: any,
  message: string,
  contactName?: string
): Promise<boolean> {
  try {
    console.log(`📱 Enviando respuesta automática vía WhatsApp para conversación ${conversationData.id}`);
    
    // Obtener el número de teléfono desde custom_data
    let phoneNumber: string | null = null;
    
    if (conversationData.custom_data?.whatsapp_phone) {
      phoneNumber = conversationData.custom_data.whatsapp_phone;
    } else if (conversationData.custom_data?.phone) {
      phoneNumber = conversationData.custom_data.phone;
    }
    
    if (!phoneNumber) {
      console.error('❌ No se encontró número de teléfono en la conversación de WhatsApp');
      return false;
    }
    
    // Mensaje automático informando que se contactará un humano
    const autoMessage = `Hola ${contactName || 'estimado/a cliente'}, ` +
      `hemos recibido tu solicitud de ayuda: "${message}". ` +
      `Un miembro de nuestro equipo se pondrá en contacto contigo pronto. ` +
      `Gracias por tu paciencia. 🙏`;
    
    const result = await WhatsAppSendService.sendMessage({
      phone_number: phoneNumber,
      message: autoMessage,
      from: 'Equipo de Soporte',
      site_id: conversationData.site_id,
      conversation_id: conversationData.id,
      lead_id: conversationData.lead_id
    });
    
    if (result.success) {
      console.log(`✅ Respuesta automática de WhatsApp enviada: ${result.message_id}`);
      return true;
    } else {
      console.error(`❌ Error al enviar respuesta automática de WhatsApp:`, result.error);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error inesperado al enviar respuesta automática de WhatsApp:', error);
    return false;
  }
}

/**
 * Función para enviar respuesta automática vía email
 */
async function sendEmailAutoResponse(
  conversationData: any,
  message: string,
  contactEmail?: string,
  contactName?: string
): Promise<boolean> {
  try {
    console.log(`📧 Enviando respuesta automática vía email para conversación ${conversationData.id}`);
    
    let emailAddress = contactEmail;
    
    // Si no se proporciona email, intentar obtenerlo del lead
    if (!emailAddress && conversationData.lead_id) {
      const { data: lead, error: leadError } = await supabaseAdmin
        .from('leads')
        .select('email')
        .eq('id', conversationData.lead_id)
        .single();
      
      if (!leadError && lead?.email) {
        emailAddress = lead.email;
      }
    }
    
    if (!emailAddress) {
      console.error('❌ No se encontró dirección de email para enviar respuesta automática');
      return false;
    }
    
    // Usar VisitorNotificationService para enviar el email
    const result = await VisitorNotificationService.notifyMessageReceived({
      visitorEmail: emailAddress,
      visitorName: contactName,
      message: `Hemos recibido tu solicitud: "${message}". Un miembro de nuestro equipo se pondrá en contacto contigo pronto.`,
      agentName: 'Sistema de Soporte',
      summary: 'Solicitud de ayuda humana recibida y en proceso',
      supportEmail: process.env.SUPPORT_EMAIL || 'support@uncodie.com'
    });
    
    if (result.success) {
      console.log(`✅ Respuesta automática por email enviada a: ${emailAddress}`);
      return true;
    } else {
      console.error(`❌ Error al enviar respuesta automática por email:`, result.error);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error inesperado al enviar respuesta automática por email:', error);
    return false;
  }
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
    
    // Verificar que la conversación existe y obtener información del origen
    const { data: conversationData, error: conversationError } = await supabaseAdmin
      .from('conversations')
      .select('id, user_id, title, site_id, lead_id, visitor_id, channel, custom_data')
      .eq('id', conversation_id)
      .maybeSingle();
    
    if (conversationError) {
      console.error('Error al verificar la conversación:', conversationError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'Failed to verify conversation' 
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
            code: 'CONVERSATION_NOT_FOUND', 
            message: 'The specified conversation was not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Detectar el origen de la conversación
    let conversationOrigin = 'web'; // Default
    
    // Verificar en el campo channel directo
    if (conversationData.channel) {
      conversationOrigin = conversationData.channel;
    } 
    // Verificar en custom_data.channel como fallback
    else if (conversationData.custom_data && conversationData.custom_data.channel) {
      conversationOrigin = conversationData.custom_data.channel;
    }
    // Verificar en custom_data.source (formato anterior)
    else if (conversationData.custom_data && conversationData.custom_data.source) {
      conversationOrigin = conversationData.custom_data.source;
    }
    
    console.log(`📺 Origen de conversación detectado: "${conversationOrigin}" para conversación ${conversation_id}`);
    
    // Variables para almacenar datos del agente
    let agentData = null;
    
    // Verificar que el agente existe, solo si se proporcionó un agent_id
    if (agent_id) {
      const { data: agent, error: agentError } = await supabaseAdmin
        .from('agents')
        .select('id, name, site_id')
        .eq('id', agent_id)
        .maybeSingle();
      
      if (agentError) {
        console.error('Error al verificar el agente:', agentError);
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'DATABASE_ERROR', 
              message: 'Failed to verify agent' 
            } 
          },
          { status: 500 }
        );
      }
      
      if (!agent) {
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

    // Variables para tracking de respuestas automáticas
    let channelResponseSent = false;
    let channelResponseType = 'none';
    
    if (!teamNotificationResult.success) {
      console.error('Error al notificar al equipo:', teamNotificationResult.errors);
    } else {
      console.log(`Equipo notificado exitosamente: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
      
      // Enviar respuesta automática según el origen de la conversación
      if (conversationOrigin === 'whatsapp') {
        console.log(`📱 Conversación de WhatsApp detectada - enviando respuesta automática`);
        channelResponseSent = await sendWhatsAppAutoResponse(conversationData, message, name);
        channelResponseType = 'whatsapp';
      } else if (conversationOrigin === 'email') {
        console.log(`📧 Conversación de email detectada - enviando respuesta automática`);
        channelResponseSent = await sendEmailAutoResponse(conversationData, message, email, name);
        channelResponseType = 'email';
      } else {
        console.log(`🌐 Conversación web detectada - solo notificación al equipo`);
        
        // Para conversaciones web, mantener el comportamiento original si hay email del visitante
        if (email) {
          console.log(`📧 Enviando confirmación al visitante vía email: ${email}`);
          
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
            channelResponseSent = true;
            channelResponseType = 'email_fallback';
          } else {
            console.error(`❌ Error al notificar al visitante ${email}:`, visitorNotificationResult.error);
          }
        }
      }
    }
    
    // Crear task de soporte para el lead si existe
    let supportTaskId = null;
    if (conversationData.lead_id) {
      console.log(`📋 Creando task de soporte para el lead asociado`);
      supportTaskId = await createSupportTask(
        conversation_id,
        conversationData.lead_id,
        siteId,
        conversationData.user_id,
        message,
        summary,
        name,
        priority
      );
      
      if (supportTaskId) {
        console.log(`✅ Task de soporte creado: ${supportTaskId}`);
      } else {
        console.log(`⚠️ No se pudo crear el task de soporte`);
      }
    } else {
      console.log(`ℹ️ No se crea task de soporte: no hay lead asociado a la conversación`);
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
        conversation_origin: conversationOrigin,
        team_notification: {
          notifications_sent: teamNotificationResult.notificationsSent,
          emails_sent: teamNotificationResult.emailsSent,
          notified_emails: notifiedEmails,
          total_members: teamNotificationResult.totalMembers
        },
        channel_response: {
          sent: channelResponseSent,
          type: channelResponseType,
          channel: conversationOrigin
        },
        visitor_notification: {
          sent: !!email && teamNotificationResult.success,
          email: email || null
        },
        support_task: {
          created: !!supportTaskId,
          task_id: supportTaskId
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