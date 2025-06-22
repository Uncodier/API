import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const TaskStatusSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  lead_id: z.string().uuid('lead_id debe ser un UUID válido'),
  message: z.string().min(1, 'message es requerido'),
  task_id: z.string().uuid('task_id debe ser un UUID válido').optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  notification_type: z.enum(['task_update', 'task_completed', 'task_failed', 'task_cancelled']).default('task_update'),
  include_team: z.boolean().default(true),
  include_lead: z.boolean().default(true),
  additional_data: z.record(z.any()).optional()
});

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener información del lead
async function getLeadInfo(leadId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del lead:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del lead:', error);
    return null;
  }
}

// Función para obtener información del sitio
async function getSiteInfo(siteId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', siteId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del sitio:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del sitio:', error);
    return null;
  }
}

// Función para obtener información de la tarea (si se proporciona task_id)
async function getTaskInfo(taskId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();
    
    if (error) {
      console.error('Error al obtener información de la tarea:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener información de la tarea:', error);
    return null;
  }
}

// Funciones de branding consistentes
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Función para generar HTML del email para el lead
function generateLeadNotificationHtml(data: {
  leadName: string;
  message: string;
  siteName: string;
  taskTitle?: string;
  status?: string;
  priority: string;
  siteUrl?: string;
}): string {
  const statusBadgeColor = {
    pending: { bg: '#fef3c7', color: '#92400e' },
    in_progress: { bg: '#dbeafe', color: '#1e40af' },
    completed: { bg: '#d1fae5', color: '#065f46' },
    failed: { bg: '#fee2e2', color: '#991b1b' },
    cancelled: { bg: '#f3f4f6', color: '#374151' }
  };
  
  const priorityColor = {
    low: { bg: '#f3f4f6', color: '#374151' },
    normal: { bg: '#dbeafe', color: '#1e40af' },
    high: { bg: '#fed7aa', color: '#c2410c' },
    urgent: { bg: '#fee2e2', color: '#991b1b' }
  };
  
  const statusColor = data.status ? statusBadgeColor[data.status as keyof typeof statusBadgeColor] : statusBadgeColor.pending;
  const priorityBadge = priorityColor[data.priority as keyof typeof priorityColor];
  
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Actualización de Estado - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 50%; position: relative;">
              <div style="position: absolute; top: 8px; left: 8px; width: 8px; height: 8px; background-color: #10b981; border-radius: 50%;"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Actualización de Estado</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Hemos recibido una actualización para ti</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Greeting -->
          <div style="margin-bottom: 32px;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              Hola ${data.leadName}
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              Te escribimos desde ${data.siteName} para informarte sobre una actualización importante.
            </p>
          </div>
          
          <!-- Status and Priority Badges -->
          ${data.status || data.priority ? `
          <div style="margin-bottom: 32px; text-align: center;">
            ${data.status ? `
            <div style="display: inline-block; background-color: ${statusColor.bg}; color: ${statusColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 8px;">
              ${data.status.replace('_', ' ')}
            </div>
            ` : ''}
            <div style="display: inline-block; background-color: ${priorityBadge.bg}; color: ${priorityBadge.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.priority} Priority
            </div>
          </div>
          ` : ''}
          
          <!-- Task Information -->
          ${data.taskTitle ? `
          <div style="margin-bottom: 32px;">
            <div style="background-color: #f8fafc; padding: 20px 24px; border-radius: 8px; border-left: 4px solid #667eea;">
              <h3 style="margin: 0 0 8px; font-size: 16px; color: #1e293b; font-weight: 600;">Tarea</h3>
              <p style="margin: 0; color: #475569; font-size: 15px;">${data.taskTitle}</p>
            </div>
          </div>
          ` : ''}
          
          <!-- Message -->
          <div style="margin-bottom: 32px;">
            <div style="background-color: #eff6ff; padding: 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e40af; font-weight: 600;">Mensaje</h3>
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- Action Button -->
          ${data.siteUrl ? `
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.siteUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s;">
              Visitar Sitio →
            </a>
          </div>
          ` : ''}
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            Este email fue generado automáticamente por ${getCompanyName()}.<br>
            Si tienes alguna pregunta, puedes responder a este mensaje.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong style="color: #667eea;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

// Función para generar HTML del email para el equipo
function generateTeamNotificationHtml(data: {
  leadName: string;
  leadEmail: string;
  message: string;
  siteName: string;
  taskTitle?: string;
  status?: string;
  priority: string;
  taskUrl?: string;
  additionalData?: any;
}): string {
  const statusBadgeColor = {
    pending: { bg: '#fef3c7', color: '#92400e' },
    in_progress: { bg: '#dbeafe', color: '#1e40af' },
    completed: { bg: '#d1fae5', color: '#065f46' },
    failed: { bg: '#fee2e2', color: '#991b1b' },
    cancelled: { bg: '#f3f4f6', color: '#374151' }
  };
  
  const priorityColor = {
    low: { bg: '#f3f4f6', color: '#374151' },
    normal: { bg: '#dbeafe', color: '#1e40af' },
    high: { bg: '#fed7aa', color: '#c2410c' },
    urgent: { bg: '#fee2e2', color: '#991b1b' }
  };
  
  const statusColor = data.status ? statusBadgeColor[data.status as keyof typeof statusBadgeColor] : statusBadgeColor.pending;
  const priorityBadge = priorityColor[data.priority as keyof typeof priorityColor];
  
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Task Status Update - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 50%; position: relative;">
              <div style="position: absolute; top: 8px; left: 8px; width: 8px; height: 8px; background-color: #f59e0b; border-radius: 50%;"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Task Status Update</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Nueva actualización de estado para revisar</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Status and Priority Badges -->
          <div style="margin-bottom: 32px; text-align: center;">
            ${data.status ? `
            <div style="display: inline-block; background-color: ${statusColor.bg}; color: ${statusColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 8px;">
              ${data.status.replace('_', ' ')}
            </div>
            ` : ''}
            <div style="display: inline-block; background-color: ${priorityBadge.bg}; color: ${priorityBadge.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.priority} Priority
            </div>
          </div>
          
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Lead Information</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Name:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
              </div>
              <div>
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Email:</span>
                <a href="mailto:${data.leadEmail}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">
                  ${data.leadEmail}
                </a>
              </div>
            </div>
          </div>
          
          <!-- Task Information -->
          ${data.taskTitle ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Task Information</h3>
            <div style="background-color: #f8fafc; padding: 20px 24px; border-radius: 8px; border-left: 4px solid #667eea;">
              <p style="margin: 0; color: #475569; font-size: 15px; font-weight: 600;">${data.taskTitle}</p>
            </div>
          </div>
          ` : ''}
          
          <!-- Message -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Update Message</h3>
            <div style="background-color: #f1f5f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- Additional Data -->
          ${data.additionalData && Object.keys(data.additionalData).length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Additional Information</h3>
            <div style="background-color: #fefce8; padding: 20px 24px; border-radius: 8px; border: 1px solid #fde047;">
              ${Object.entries(data.additionalData).map(([key, value]) => `
                <div style="margin-bottom: 8px;">
                  <span style="display: inline-block; font-weight: 600; color: #a16207; min-width: 100px; text-transform: capitalize;">${key.replace('_', ' ')}:</span>
                  <span style="color: #1e293b; font-size: 14px;">${typeof value === 'object' ? JSON.stringify(value) : value}</span>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Action Button -->
          ${data.taskUrl ? `
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.taskUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s;">
              Ver Tarea →
            </a>
          </div>
          ` : ''}
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            Esta notificación fue generada automáticamente por ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong style="color: #667eea;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('📧 [TaskStatus] Iniciando notificación de estado de tarea');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = TaskStatusSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [TaskStatus] Error de validación:', validationResult.error.errors);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        },
        { status: 400 }
      );
    }
    
    const {
      site_id,
      lead_id,
      message,
      task_id,
      status,
      priority,
      notification_type,
      include_team,
      include_lead,
      additional_data
    } = validationResult.data;
    
    console.log(`📋 [TaskStatus] Procesando notificación para sitio: ${site_id}, lead: ${lead_id}`);
    
    // Obtener información del lead
    const leadInfo = await getLeadInfo(lead_id);
    if (!leadInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'LEAD_NOT_FOUND',
            message: 'Lead not found'
          }
        },
        { status: 404 }
      );
    }
    
    // Obtener información del sitio
    const siteInfo = await getSiteInfo(site_id);
    if (!siteInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SITE_NOT_FOUND',
            message: 'Site not found'
          }
        },
        { status: 404 }
      );
    }
    
    // Obtener información de la tarea si se proporciona task_id
    let taskInfo = null;
    if (task_id) {
      taskInfo = await getTaskInfo(task_id);
    }
    
    const results = {
      success: true,
      notifications_sent: {
        team: 0,
        lead: 0
      },
      emails_sent: {
        team: 0,
        lead: 0
      },
      errors: [] as string[]
    };
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const taskUrl = task_id ? `${baseUrl}/sites/${site_id}/tasks/${task_id}` : undefined;
    const siteUrl = `${baseUrl}/sites/${site_id}`;
    
    // Mapear el tipo de notificación
    const notificationTypeMap = {
      task_update: NotificationType.INFO,
      task_completed: NotificationType.SUCCESS,
      task_failed: NotificationType.ERROR,
      task_cancelled: NotificationType.WARNING
    };
    
    const notificationType = notificationTypeMap[notification_type] || NotificationType.INFO;
    
    // 1. Notificar al equipo si está habilitado
    if (include_team) {
      console.log('📢 [TaskStatus] Notificando al equipo...');
      
      try {
        const teamNotificationResult = await TeamNotificationService.notifyTeam({
          siteId: site_id,
          title: `Task Status Update: ${taskInfo?.title || 'Untitled Task'}`,
          message: `Task status update for lead ${leadInfo.name}: ${message}`,
          htmlContent: generateTeamNotificationHtml({
            leadName: leadInfo.name || 'Unknown Lead',
            leadEmail: leadInfo.email || 'No email',
            message,
            siteName: siteInfo.name || 'Unknown Site',
            taskTitle: taskInfo?.title,
            status,
            priority,
            taskUrl,
            additionalData: additional_data
          }),
          priority: priority as any,
          type: notificationType,
          categories: ['task-notification', 'task-status-update'],
          customArgs: {
            taskId: task_id || '',
            leadId: lead_id,
            notificationType: notification_type
          },
          relatedEntityType: 'task',
          relatedEntityId: task_id || lead_id
        });
        
        if (teamNotificationResult.success) {
          results.notifications_sent.team = teamNotificationResult.notificationsSent;
          results.emails_sent.team = teamNotificationResult.emailsSent;
          console.log(`✅ [TaskStatus] Equipo notificado: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
        } else {
          const errorMsg = `Failed to notify team: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`;
          results.errors.push(errorMsg);
          console.error(`❌ [TaskStatus] ${errorMsg}`);
        }
      } catch (error) {
        const errorMsg = `Error notifying team: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.errors.push(errorMsg);
        console.error(`❌ [TaskStatus] ${errorMsg}`, error);
      }
    }
    
    // 2. Notificar al lead si está habilitado y tiene email
    if (include_lead && leadInfo.email) {
      console.log(`📧 [TaskStatus] Notificando al lead: ${leadInfo.email}`);
      
      try {
        const leadEmailResult = await sendGridService.sendEmail({
          to: leadInfo.email,
          subject: `Actualización de Estado - ${siteInfo.name || 'Notification'}`,
          html: generateLeadNotificationHtml({
            leadName: leadInfo.name || 'Estimado/a',
            message,
            siteName: siteInfo.name || 'Our Team',
            taskTitle: taskInfo?.title,
            status,
            priority,
            siteUrl
          }),
          categories: ['task-notification', 'lead-notification', 'transactional'],
          customArgs: {
            siteId: site_id,
            leadId: lead_id,
            taskId: task_id || '',
            notificationType: notification_type
          }
        });
        
        if (leadEmailResult.success) {
          results.emails_sent.lead = 1;
          console.log(`✅ [TaskStatus] Lead notificado exitosamente: ${leadInfo.email}`);
        } else {
          const errorMsg = `Failed to notify lead: ${leadEmailResult.error}`;
          results.errors.push(errorMsg);
          console.error(`❌ [TaskStatus] ${errorMsg}`);
        }
      } catch (error) {
        const errorMsg = `Error notifying lead: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.errors.push(errorMsg);
        console.error(`❌ [TaskStatus] ${errorMsg}`, error);
      }
    } else if (include_lead && !leadInfo.email) {
      const errorMsg = 'Lead notification requested but lead has no email';
      results.errors.push(errorMsg);
      console.warn(`⚠️ [TaskStatus] ${errorMsg}`);
    }
    
    // Determinar el éxito general
    const totalNotificationsSent = results.notifications_sent.team + results.notifications_sent.lead;
    const totalEmailsSent = results.emails_sent.team + results.emails_sent.lead;
    const hasNotifications = totalNotificationsSent > 0 || totalEmailsSent > 0;
    
    results.success = hasNotifications && results.errors.length === 0;
    
    console.log(`📊 [TaskStatus] Resumen de notificaciones:`, {
      success: results.success,
      team_notifications: results.notifications_sent.team,
      team_emails: results.emails_sent.team,
      lead_emails: results.emails_sent.lead,
      errors: results.errors.length
    });
    
    return NextResponse.json({
      success: results.success,
      data: {
        site_id,
        lead_id,
        task_id,
        notification_type,
        lead_info: {
          name: leadInfo.name,
          email: leadInfo.email
        },
        site_info: {
          name: siteInfo.name
        },
        task_info: taskInfo ? {
          title: taskInfo.title,
          status: taskInfo.status
        } : null,
        notifications_sent: results.notifications_sent,
        emails_sent: results.emails_sent,
        total_recipients: {
          team: results.notifications_sent.team,
          lead: results.emails_sent.lead
        },
        errors: results.errors.length > 0 ? results.errors : undefined,
        sent_at: new Date().toISOString()
      }
    }, { 
      status: results.success ? 200 : (results.errors.length > 0 ? 207 : 500) // 207 = Multi-Status (partial success)
    });
    
  } catch (error) {
    console.error('❌ [TaskStatus] Error general:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: 'An internal system error occurred'
        }
      },
      { status: 500 }
    );
  }
}