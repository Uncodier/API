import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationCategory, NotificationPriority } from '@/lib/services/notification-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { extractApiKeyCredential, isServiceApiKeyCredential } from '@/lib/security/api-key-credential';
import { VisitorNotificationService } from '@/lib/services/visitor-notification-service';
import { v4 as uuidv4 } from 'uuid';
import { isValidUUID, notifyVoiceTeamWithinBudget, createSupportTask, sendChannelAutoResponse, sendEmailAutoResponse, sendWhatsAppAutoResponse } from './intervention-operations';
export { getInterventionStatus as GET } from './intervention-status';

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
      email,
      voice_call_delivery_id
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
    if (voice_call_delivery_id !== undefined && (
      typeof voice_call_delivery_id !== 'string' || !isValidUUID(voice_call_delivery_id)
    )) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'voice_call_delivery_id must be a valid UUID when provided' }
      }, { status: 400 });
    }
    if (voice_call_delivery_id !== undefined &&
        !await isServiceApiKeyCredential(extractApiKeyCredential(request))) {
      return NextResponse.json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Active voice call binding requires a service credential.' }
      }, { status: 403 });
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
    if (!conversationData || conversationData.channel === 'internal_review') {
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
    if (voice_call_delivery_id !== undefined) {
      // The voice executor resolves this binding server-side. Outbound calls can
      // reuse chat conversations, so validate the active delivery before any
      // writes/sends rather than relying on the conversation's original channel.
      const invalidBinding = () => NextResponse.json({
        success: false,
        error: {
          code: 'VOICE_CALL_BINDING_INVALID',
          message: 'No active voice call is bound to this conversation.'
        }
      }, { status: 409 });
      if (!conversationData.site_id) return invalidBinding();
      const { data: delivery, error: deliveryError } = await supabaseAdmin
        .from('voice_call_deliveries')
        .select('id, zavu_call_id')
        .eq('id', voice_call_delivery_id)
        .eq('conversation_id', conversation_id)
        .eq('site_id', conversationData.site_id)
        .in('status', ['initiated', 'ringing', 'answered', 'in_progress'])
        .is('ended_at', null)
        .maybeSingle();
      if (deliveryError) {
        return NextResponse.json({
          success: false,
          error: { code: 'DATABASE_ERROR', message: 'Failed to verify active voice call' }
        }, { status: 500 });
      }
      if (!delivery || delivery.id !== voice_call_delivery_id ||
          typeof delivery.zavu_call_id !== 'string' || !delivery.zavu_call_id.trim()) {
        return invalidBinding();
      }
      conversationOrigin = 'voice';
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
    if (conversationOrigin === 'voice') {
      // Escalation is a pending request, not a live transfer or permission to
      // contact the caller on another channel. Keep it out of the web fallback.
      // Attempt each write independently so a failed audit message/notification
      // cannot prevent a durable support task (or hide an accepted notification).
      const [messageResult, notificationResult, taskResult] = await Promise.allSettled([
        (async () => supabaseAdmin.from('messages').insert([systemMessageData]))(),
        notifyVoiceTeamWithinBudget({
          siteId,
          conversationId: conversation_id,
          message,
          priority,
          agentName: agentData?.name,
          summary,
          contactName: name,
          contactEmail: email
        }),
        createSupportTask(
          conversation_id,
          conversationData.lead_id,
          siteId,
          conversationData.user_id,
          message,
          summary,
          name,
          priority
        )
      ]);
      const teamNotification = notificationResult.status === 'fulfilled' ? notificationResult.value.result : null;
      const notificationTimedOut = notificationResult.status === 'fulfilled' && notificationResult.value.timedOut;
      const supportTaskId = taskResult.status === 'fulfilled' ? taskResult.value : null;
      // notifyHumanIntervention can report success with no eligible recipients,
      // or retain positive counts after a later failure. Counts are the evidence
      // of persisted team notifications/provider-accepted team emails, not reads.
      const notificationsSent = teamNotification?.notificationsSent || 0;
      const emailsSent = teamNotification?.emailsSent || 0;
      const teamNotificationAccepted = notificationsSent > 0 || emailsSent > 0;
      const accepted = !!supportTaskId || teamNotificationAccepted;
      return NextResponse.json({
        success: accepted,
        ...(!accepted ? {
          error: {
            code: 'HUMAN_INTERVENTION_UNAVAILABLE',
            message: 'Unable to confirm queued human assistance. No support task or team notification acceptance was confirmed.'
          }
        } : {}),
        data: {
          intervention_id: interventionId,
          conversation_id,
          message,
          priority,
          status: accepted ? 'pending' : 'failed',
          human_joined: false,
          created_at: new Date().toISOString(),
          summary,
          contact_name: name,
          contact_email: email,
          conversation_origin: conversationOrigin,
          team_notification: {
            accepted: teamNotificationAccepted,
            timed_out: notificationTimedOut,
            notifications_sent: notificationsSent,
            emails_sent: emailsSent,
            total_members: teamNotification?.totalMembers || 0
          },
          channel_response: { sent: false, type: 'none', channel: 'voice' },
          visitor_notification: { sent: false, email: email || null },
          support_task: { created: !!supportTaskId, task_id: supportTaskId },
          system_message: {
            saved: messageResult.status === 'fulfilled' && !messageResult.value.error
          }
        }
      }, { status: accepted ? 202 : 503 });
    }
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
    const teamMembers = await TeamNotificationService.getTeamMembersWithEmailNotifications(
      siteId,
      [NotificationCategory.HUMAN_INTERVENTION]
    );
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
      } else if (['telegram', 'messenger', 'zavu'].includes(conversationOrigin)) {
        console.log(`📺 Conversación de Zavu (${conversationOrigin}) detectada - enviando respuesta automática`);
        channelResponseSent = await sendChannelAutoResponse(conversationData, conversationOrigin, message, name);
        channelResponseType = conversationOrigin;
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
            supportEmail: process.env.SUPPORT_EMAIL || 'support@makinari.com'
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
