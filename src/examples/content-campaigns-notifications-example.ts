/**
 * Content & Campaigns Notifications Examples
 * 
 * Este archivo contiene ejemplos prácticos de cómo usar las nuevas notificaciones
 * para contenido y campañas.
 */

import { z } from 'zod';

// Tipos para las notificaciones
type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';
type ContentStatus = 'draft' | 'review' | 'approved';
type CampaignStatus = 'pending' | 'approved' | 'in_progress';

interface NotificationResponse {
  success: boolean;
  data?: {
    site_id: string;
    notification_sent: boolean;
    notifications_sent: number;
    emails_sent: number;
    sent_at: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

const API_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';

/**
 * Ejemplo 1: Notificación diaria de contenido nuevo en borrador
 * 
 * Este ejemplo muestra cómo notificar sobre contenido nuevo creado en las últimas 24 horas
 * que está en estado 'draft' y necesita revisión.
 */
export async function dailyContentReviewAlert(siteId: string): Promise<NotificationResponse> {
  const response = await fetch(`${API_BASE_URL}/api/notifications/newContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      site_id: siteId,
      priority: 'normal',
      include_content_details: true,
      max_content_to_display: 15,
      content_status: 'draft',
      days_since_created: 1 // Último día
    })
  });

  return await response.json();
}

/**
 * Ejemplo 2: Notificación semanal de campañas pendientes
 * 
 * Este ejemplo muestra cómo notificar sobre campañas propuestas por IA
 * que están esperando aprobación humana.
 */
export async function weeklyCampaignReviewAlert(siteId: string): Promise<NotificationResponse> {
  const response = await fetch(`${API_BASE_URL}/api/notifications/newCampaigns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      site_id: siteId,
      priority: 'high',
      include_campaign_details: true,
      max_campaigns_to_display: 10,
      campaign_status: 'pending',
      days_since_created: 7 // Última semana
    })
  });

  return await response.json();
}

/**
 * Ejemplo 3: Notificación urgente de contenido listo para publicar
 * 
 * Este ejemplo muestra cómo notificar sobre contenido que ya fue aprobado
 * y está listo para ser publicado.
 */
export async function urgentContentPublishAlert(siteId: string): Promise<NotificationResponse> {
  const response = await fetch(`${API_BASE_URL}/api/notifications/newContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      site_id: siteId,
      priority: 'urgent',
      include_content_details: true,
      max_content_to_display: 5,
      content_status: 'approved', // Contenido aprobado listo para publicar
      days_since_created: 3
    })
  });

  return await response.json();
}

/**
 * Ejemplo 4: Notificación de campañas aprobadas listas para ejecución
 * 
 * Este ejemplo muestra cómo notificar sobre campañas que han sido aprobadas
 * y están listas para comenzar su ejecución.
 */
export async function campaignExecutionAlert(siteId: string): Promise<NotificationResponse> {
  const response = await fetch(`${API_BASE_URL}/api/notifications/newCampaigns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      site_id: siteId,
      priority: 'high',
      include_campaign_details: true,
      max_campaigns_to_display: 8,
      campaign_status: 'approved',
      days_since_created: 5
    })
  });

  return await response.json();
}

/**
 * Ejemplo 5: Flujo completo de monitoreo automatizado
 * 
 * Este ejemplo muestra cómo implementar un flujo de monitoreo que revisa
 * tanto contenido como campañas de manera automatizada.
 */
export async function automatedWorkflowMonitoring(siteId: string) {
  console.log(`🔄 Iniciando monitoreo automatizado para sitio: ${siteId}`);
  
  try {
    // 1. Revisar contenido nuevo en borrador (últimas 24 horas)
    console.log('📝 Verificando contenido nuevo...');
    const contentResult = await dailyContentReviewAlert(siteId);
    
    if (contentResult.success && contentResult.data?.notification_sent) {
      console.log(`✅ Notificación de contenido enviada: ${contentResult.data.notifications_sent} destinatarios`);
    } else {
      console.log('ℹ️ No hay contenido nuevo para notificar');
    }

    // 2. Revisar campañas pendientes (última semana)
    console.log('🚀 Verificando campañas pendientes...');
    const campaignResult = await weeklyCampaignReviewAlert(siteId);
    
    if (campaignResult.success && campaignResult.data?.notification_sent) {
      console.log(`✅ Notificación de campañas enviada: ${campaignResult.data.notifications_sent} destinatarios`);
    } else {
      console.log('ℹ️ No hay campañas nuevas para notificar');
    }

    // 3. Verificar contenido aprobado urgente
    console.log('⚡ Verificando contenido aprobado urgente...');
    const urgentContentResult = await urgentContentPublishAlert(siteId);
    
    if (urgentContentResult.success && urgentContentResult.data?.notification_sent) {
      console.log(`🚨 Notificación urgente de contenido enviada: ${urgentContentResult.data.notifications_sent} destinatarios`);
    }

    return {
      success: true,
      results: {
        content_notifications: contentResult.data?.notifications_sent || 0,
        campaign_notifications: campaignResult.data?.notifications_sent || 0,
        urgent_content_notifications: urgentContentResult.data?.notifications_sent || 0,
        total_notifications: (contentResult.data?.notifications_sent || 0) + 
                           (campaignResult.data?.notifications_sent || 0) + 
                           (urgentContentResult.data?.notifications_sent || 0)
      }
    };

  } catch (error) {
    console.error('❌ Error en monitoreo automatizado:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Ejemplo 6: Notificación personalizada por tipo de contenido
 * 
 * Este ejemplo muestra cómo enviar notificaciones específicas según el tipo
 * y volumen de contenido creado.
 */
export async function contentTypeSpecificAlert(siteId: string, contentTypes: string[] = ['blog_post', 'video', 'social_post']) {
  console.log(`📋 Enviando alertas específicas por tipo de contenido para: ${contentTypes.join(', ')}`);
  
  const results = [];
  
  for (const contentType of contentTypes) {
    try {
      // Nota: Este ejemplo asume que podrías filtrar por tipo en el futuro
      // Por ahora, envía la notificación general y menciona el tipo en el log
      const result = await fetch(`${API_BASE_URL}/api/notifications/newContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          site_id: siteId,
          priority: contentType === 'video' ? 'high' : 'normal', // Videos tienen prioridad alta
          include_content_details: true,
          max_content_to_display: 20,
          content_status: 'draft',
          days_since_created: 3
        })
      });

      const data = await result.json();
      results.push({
        content_type: contentType,
        success: data.success,
        notifications_sent: data.data?.notifications_sent || 0
      });

      console.log(`📄 ${contentType}: ${data.data?.notifications_sent || 0} notificaciones enviadas`);

    } catch (error) {
      console.error(`❌ Error notificando ${contentType}:`, error);
      results.push({
        content_type: contentType,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return results;
}

/**
 * Ejemplo 7: Configuración de horarios de notificación
 * 
 * Este ejemplo muestra cómo programar notificaciones en horarios específicos
 * para diferentes tipos de alertas.
 */
export class NotificationScheduler {
  private siteId: string;

  constructor(siteId: string) {
    this.siteId = siteId;
  }

  /**
   * Programa notificaciones diarias de contenido a las 9 AM
   */
  async scheduleDailyContentReview() {
    console.log('⏰ Programando revisión diaria de contenido para las 9 AM');
    
    // En un entorno real, esto se configuraría con un cron job o scheduler
    const now = new Date();
    const scheduledTime = new Date();
    scheduledTime.setHours(9, 0, 0, 0);

    // Si ya pasaron las 9 AM hoy, programar para mañana
    if (now > scheduledTime) {
      scheduledTime.setDate(scheduledTime.getDate() + 1);
    }

    const timeUntilExecution = scheduledTime.getTime() - now.getTime();

    return {
      scheduled_for: scheduledTime.toISOString(),
      time_until_execution_ms: timeUntilExecution,
      message: `Notificación programada para ${scheduledTime.toLocaleString()}`
    };
  }

  /**
   * Programa notificaciones semanales de campañas los lunes a las 10 AM
   */
  async scheduleWeeklyCampaignReview() {
    console.log('📅 Programando revisión semanal de campañas para los lunes a las 10 AM');
    
    const now = new Date();
    const nextMonday = new Date();
    const daysUntilMonday = (1 + 7 - now.getDay()) % 7;
    
    nextMonday.setDate(now.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday));
    nextMonday.setHours(10, 0, 0, 0);

    const timeUntilExecution = nextMonday.getTime() - now.getTime();

    return {
      scheduled_for: nextMonday.toISOString(),
      time_until_execution_ms: timeUntilExecution,
      message: `Notificación programada para ${nextMonday.toLocaleString()}`
    };
  }
}

/**
 * Ejemplo 8: Integración con webhooks externos
 * 
 * Este ejemplo muestra cómo integrar las notificaciones con sistemas externos
 * como Slack, Discord, o otros webhooks.
 */
export async function integrateWithExternalWebhooks(
  siteId: string, 
  webhookUrl: string,
  platform: 'slack' | 'discord' | 'teams' = 'slack'
) {
  console.log(`🔗 Integrando notificaciones con webhook ${platform}: ${webhookUrl}`);

  try {
    // 1. Obtener datos de contenido y campañas
    const [contentResult, campaignResult] = await Promise.all([
      dailyContentReviewAlert(siteId),
      weeklyCampaignReviewAlert(siteId)
    ]);

    // 2. Preparar mensaje para el webhook
    const totalNotifications = (contentResult.data?.notifications_sent || 0) + 
                              (campaignResult.data?.notifications_sent || 0);

    if (totalNotifications === 0) {
      console.log('ℹ️ No hay notificaciones para enviar al webhook');
      return { success: true, message: 'No notifications to send' };
    }

    // 3. Formatear mensaje según la plataforma
    let webhookPayload;
    
    switch (platform) {
      case 'slack':
        webhookPayload = {
          text: `🔔 Site Notifications Update`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*New Content & Campaigns Alert*\n\n` +
                     `📝 Content notifications: ${contentResult.data?.notifications_sent || 0}\n` +
                     `🚀 Campaign notifications: ${campaignResult.data?.notifications_sent || 0}\n` +
                     `👥 Total team members notified: ${totalNotifications}`
              }
            }
          ]
        };
        break;

      case 'discord':
        webhookPayload = {
          content: `🔔 **Site Notifications Update**\n\n` +
                  `📝 Content notifications: ${contentResult.data?.notifications_sent || 0}\n` +
                  `🚀 Campaign notifications: ${campaignResult.data?.notifications_sent || 0}\n` +
                  `👥 Total team members notified: ${totalNotifications}`
        };
        break;

      case 'teams':
        webhookPayload = {
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: {
                type: "AdaptiveCard",
                body: [
                  {
                    type: "TextBlock",
                    size: "Medium",
                    weight: "Bolder",
                    text: "🔔 Site Notifications Update"
                  },
                  {
                    type: "TextBlock",
                    text: `📝 Content notifications: ${contentResult.data?.notifications_sent || 0}\n🚀 Campaign notifications: ${campaignResult.data?.notifications_sent || 0}\n👥 Total team members notified: ${totalNotifications}`,
                    wrap: true
                  }
                ]
              }
            }
          ]
        };
        break;
    }

    // 4. Enviar al webhook
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webhookPayload)
    });

    if (webhookResponse.ok) {
      console.log(`✅ Webhook ${platform} enviado exitosamente`);
      return {
        success: true,
        platform,
        notifications_sent: totalNotifications,
        webhook_status: webhookResponse.status
      };
    } else {
      throw new Error(`Webhook failed with status: ${webhookResponse.status}`);
    }

  } catch (error) {
    console.error(`❌ Error enviando webhook ${platform}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Ejemplo de uso completo
 * 
 * Este es un ejemplo de cómo usar todas las funciones anteriores en un flujo real.
 */
export async function completeNotificationWorkflow(siteId: string) {
  console.log('🚀 Iniciando flujo completo de notificaciones...');

  const results = {
    automated_monitoring: null as any,
    content_type_alerts: null as any,
    scheduler_setup: null as any,
    webhook_integration: null as any
  };

  try {
    // 1. Ejecutar monitoreo automatizado
    console.log('1️⃣ Ejecutando monitoreo automatizado...');
    results.automated_monitoring = await automatedWorkflowMonitoring(siteId);

    // 2. Enviar alertas específicas por tipo de contenido
    console.log('2️⃣ Enviando alertas por tipo de contenido...');
    results.content_type_alerts = await contentTypeSpecificAlert(siteId, ['blog_post', 'video']);

    // 3. Configurar scheduler para futuras notificaciones
    console.log('3️⃣ Configurando scheduler...');
    const scheduler = new NotificationScheduler(siteId);
    const dailySchedule = await scheduler.scheduleDailyContentReview();
    const weeklySchedule = await scheduler.scheduleWeeklyCampaignReview();
    
    results.scheduler_setup = {
      daily_content_review: dailySchedule,
      weekly_campaign_review: weeklySchedule
    };

    // 4. Integrar con webhook (ejemplo con URL de prueba)
    console.log('4️⃣ Integrando con webhooks...');
    // results.webhook_integration = await integrateWithExternalWebhooks(
    //   siteId, 
    //   'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK',
    //   'slack'
    // );

    console.log('✅ Flujo completo de notificaciones finalizado');
    
    return {
      success: true,
      execution_time: new Date().toISOString(),
      results
    };

  } catch (error) {
    console.error('❌ Error en flujo completo:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      partial_results: results
    };
  }
}

// Exportar todas las funciones como ejemplos
export const ContentCampaignNotificationExamples = {
  dailyContentReviewAlert,
  weeklyCampaignReviewAlert,
  urgentContentPublishAlert,
  campaignExecutionAlert,
  automatedWorkflowMonitoring,
  contentTypeSpecificAlert,
  NotificationScheduler,
  integrateWithExternalWebhooks,
  completeNotificationWorkflow
};

export default ContentCampaignNotificationExamples; 