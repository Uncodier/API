import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request (mismo que taskStatus)
const TaskCommentReminderSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  lead_id: z.string().uuid('lead_id debe ser un UUID válido'),
  message: z.string().min(1, 'message es requerido'),
  task_id: z.string().uuid('task_id debe ser un UUID válido').optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  notification_type: z.enum(['task_reminder', 'cta_reminder', 'follow_up_reminder', 'action_required']).default('task_reminder'),
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

// Función para obtener información de la tarea
async function getTaskInfo(taskId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('tasks')
      .select(`
        id,
        title,
        description,
        type,
        status,
        stage,
        priority,
        scheduled_date,
        completed_date,
        amount,
        assignee,
        notes,
        created_at,
        updated_at
      `)
      .eq('id', taskId)
      .single();
    
    if (error) {
      console.error('Error al obtener información de la tarea:', error);
      return null;
    }
    
    console.log(`📋 [TaskReminder] Información de tarea obtenida: ${data?.title || 'Sin título'}`);
    return data;
  } catch (error) {
    console.error('Error al obtener información de la tarea:', error);
    return null;
  }
}

// Función para obtener el último comentario con CTA
async function getLastTaskCommentWithCTA(taskId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('task_comments')
      .select(`
        id,
        content,
        attachments,
        files,
        cta,
        created_at,
        updated_at
      `)
      .eq('task_id', taskId)
      .eq('is_private', false)
      .not('cta', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (error) {
      console.log(`ℹ️ [TaskReminder] No se encontraron comentarios con CTA para la tarea: ${taskId}`);
      return null;
    }
    
    console.log(`💬 [TaskReminder] Comentario con CTA obtenido para tarea: ${taskId}`);
    return data;
  } catch (error) {
    console.error('Error al obtener comentario con CTA de la tarea:', error);
    return null;
  }
}

// Funciones de branding
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Función para generar HTML del reminder para el lead
function generateLeadReminderHtml(data: {
  leadName: string;
  message: string;
  siteName: string;
  taskTitle?: string;
  taskDescription?: string;
  status?: string;
  priority: string;
  siteUrl?: string;
  logoUrl?: string;
  primaryCta: {
    title: string;
    url: string;
  };
  reminderContext?: string;
}): string {
  const priorityBadgeColor = {
    low: { bg: '#f3f4f6', color: '#374151' },
    normal: { bg: '#dbeafe', color: '#1e40af' },
    high: { bg: '#fed7aa', color: '#c2410c' },
    urgent: { bg: '#fee2e2', color: '#991b1b' }
  };
  
  const priorityColor = priorityBadgeColor[data.priority as keyof typeof priorityBadgeColor] || priorityBadgeColor.normal;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Friendly Reminder - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #10b981; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">⏰ Friendly Reminder</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">You have a pending action</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Greeting -->
          <div style="margin-bottom: 32px;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              Hello ${data.leadName} 👋
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              We hope you're doing well! This is a friendly reminder from ${data.siteName}.
            </p>
          </div>
          
          
          
          <!-- Task Information -->
          ${data.taskTitle ? `
          <div style="margin-bottom: 32px;">
            <div style="background-color: #f0fdfa; padding: 20px 24px; border-radius: 8px; border-left: 4px solid #10b981;">
              <h3 style="margin: 0 0 8px; font-size: 16px; color: #1e293b; font-weight: 600;">📋 ${data.taskTitle}</h3>
              ${data.taskDescription ? `<p style="margin: 0; color: #475569; font-size: 15px; line-height: 1.6;">${data.taskDescription}</p>` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Reminder Message -->
          <div style="margin-bottom: 32px;">
            <div style="background-color: #fef3c7; padding: 24px; border-radius: 8px; border: 1px solid #fde047;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #92400e; font-weight: 600;">📢 Reminder</h3>
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- Call-to-Action -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.primaryCta.url}" 
               style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; padding: 18px 36px; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 18px; letter-spacing: -0.025em; box-shadow: 0 8px 16px -4px rgba(16, 185, 129, 0.3); transition: transform 0.2s, box-shadow 0.2s; text-transform: uppercase;">
              🎯 ${data.primaryCta.title}
            </a>
          </div>
          
          <!-- Secondary Action -->
          ${data.siteUrl ? `
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${data.siteUrl}" 
               style="color: #10b981; text-decoration: none; font-size: 14px; font-weight: 500;">
              or visit our website →
            </a>
          </div>
          ` : ''}
          
          <!-- Context Note -->
          ${data.reminderContext ? `
          <div style="margin-top: 32px; padding: 16px; background-color: #f8fafc; border-radius: 6px; border-left: 3px solid #10b981;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              <strong style="color: #475569;">Context:</strong> ${data.reminderContext}
            </p>
          </div>
          ` : ''}
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              This is a friendly reminder about your pending action. We're here to help if you have any questions!
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            This reminder was sent by ${getCompanyName()}.<br>
            If you have any questions, feel free to reply to this message.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong style="color: #10b981;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

// Función para generar HTML del reminder para el equipo
function generateTeamReminderHtml(data: {
  leadName: string;
  leadEmail: string;
  message: string;
  siteName: string;
  taskTitle?: string;
  taskDescription?: string;
  status?: string;
  priority: string;
  taskUrl?: string;
  additionalData?: any;
  logoUrl?: string;
  primaryCta: {
    title: string;
    url: string;
  };
  reminderContext?: string;
}): string {
  const priorityBadgeColor = {
    low: { bg: '#f3f4f6', color: '#374151' },
    normal: { bg: '#dbeafe', color: '#1e40af' },
    high: { bg: '#fed7aa', color: '#c2410c' },
    urgent: { bg: '#fee2e2', color: '#991b1b' }
  };
  
  const priorityColor = priorityBadgeColor[data.priority as keyof typeof priorityBadgeColor] || priorityBadgeColor.normal;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Task Reminder - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #f59e0b; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">⏰ Task Reminder</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Lead needs follow-up action</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          
          
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">👤 Lead Information</h3>
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
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">📋 Task Information</h3>
            <div style="background-color: #fefce8; padding: 20px 24px; border-radius: 8px; border-left: 4px solid #f59e0b;">
              <h4 style="margin: 0 0 8px; color: #1e293b; font-size: 15px; font-weight: 600;">${data.taskTitle}</h4>
              ${data.taskDescription ? `<p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6;">${data.taskDescription}</p>` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Reminder Message -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">📢 Reminder</h3>
            <div style="background-color: #fef3c7; padding: 24px; border-radius: 8px; border: 1px solid #fde047;">
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- CTA Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">🎯 Action Required</h3>
            <div style="background-color: #f0fdf4; padding: 20px 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <div style="margin-bottom: 16px;">
                <span style="display: inline-block; font-weight: 600; color: #16a34a; min-width: 80px;">Action:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.primaryCta.title}</span>
              </div>
              <div>
                <span style="display: inline-block; font-weight: 600; color: #16a34a; min-width: 80px;">URL:</span>
                <a href="${data.primaryCta.url}" style="color: #16a34a; text-decoration: none; font-size: 14px; word-break: break-all;">
                  ${data.primaryCta.url}
                </a>
              </div>
            </div>
          </div>
          
          <!-- Additional Data -->
          ${data.additionalData && Object.keys(data.additionalData).length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">📊 Additional Information</h3>
            <div style="background-color: #f8fafc; padding: 20px 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              ${Object.entries(data.additionalData).map(([key, value]) => `
                <div style="margin-bottom: 8px;">
                  <span style="display: inline-block; font-weight: 600; color: #475569; min-width: 100px; text-transform: capitalize;">${key.replace('_', ' ')}:</span>
                  <span style="color: #1e293b; font-size: 14px;">${typeof value === 'object' ? JSON.stringify(value) : value}</span>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Context Note -->
          ${data.reminderContext ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">📝 Context</h3>
            <div style="background-color: #f1f5f9; padding: 20px 24px; border-radius: 8px; border-left: 3px solid #64748b;">
              <p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6;">
                ${data.reminderContext}
              </p>
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.primaryCta.url}" 
               style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin-right: 12px;">
              ${data.primaryCta.title} →
            </a>
            ${data.taskUrl ? `
            <a href="${data.taskUrl}" 
               style="display: inline-block; background: #ffffff; color: #f59e0b; border: 2px solid #f59e0b; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s;">
              View Task →
            </a>
            ` : ''}
          </div>
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              This is an automated reminder about a pending task action for <strong style="color: #475569;">${data.leadName}</strong>
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            This reminder was automatically generated by ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong style="color: #f59e0b;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('⏰ [TaskReminder] Iniciando recordatorio de comentario de tarea');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = TaskCommentReminderSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [TaskReminder] Error de validación:', validationResult.error.errors);
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
    
    console.log(`📋 [TaskReminder] Procesando recordatorio para sitio: ${site_id}, lead: ${lead_id}`);
    
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
    let lastCommentWithCTA = null;
    if (task_id) {
      console.log(`🔍 [TaskReminder] Obteniendo información de tarea: ${task_id}`);
      taskInfo = await getTaskInfo(task_id);
      
      // Obtener el último comentario con CTA (requerido para reminders)
      console.log(`💬 [TaskReminder] Obteniendo último comentario con CTA de tarea: ${task_id}`);
      lastCommentWithCTA = await getLastTaskCommentWithCTA(task_id);
      
      if (!lastCommentWithCTA || !lastCommentWithCTA.cta?.primary_action) {
        console.error(`❌ [TaskReminder] No se encontró comentario con CTA para la tarea: ${task_id}`);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'CTA_NOT_FOUND',
              message: 'No CTA found in task comments. Reminders require a task with CTA.'
            }
          },
          { status: 400 }
        );
      }
    } else {
      console.error(`❌ [TaskReminder] task_id es requerido para recordatorios`);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'TASK_ID_REQUIRED',
            message: 'task_id is required for task comment reminders'
          }
        },
        { status: 400 }
      );
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
    const taskUrl = `${baseUrl}/sites/${site_id}/tasks/${task_id}`;
    const siteUrl = siteInfo.url || `${baseUrl}/sites/${site_id}`;
    
    // Preparar datos del CTA primario
    const primaryCta = {
      title: lastCommentWithCTA.cta.primary_action.title || lastCommentWithCTA.cta.primary_action.text || 'Take Action',
      url: lastCommentWithCTA.cta.primary_action.url || lastCommentWithCTA.cta.primary_action.link
    };
    
    console.log(`🎯 [TaskReminder] CTA encontrado: ${primaryCta.title} → ${primaryCta.url}`);
    
    // Mapear el tipo de notificación
    const notificationTypeMap = {
      task_reminder: NotificationType.INFO,
      cta_reminder: NotificationType.WARNING,
      follow_up_reminder: NotificationType.INFO,
      action_required: NotificationType.WARNING
    };
    
    const notificationType = notificationTypeMap[notification_type] || NotificationType.WARNING;
    
    // Contexto del recordatorio
    const reminderContext = `This is a reminder about "${taskInfo?.title || 'your pending task'}" - please take the required action when convenient.`;
    
    // 1. Notificar al equipo si está habilitado
    if (include_team) {
      console.log('📢 [TaskReminder] Enviando recordatorio al equipo...');
      
      try {
        const teamNotificationResult = await TeamNotificationService.notifyTeam({
          siteId: site_id,
          title: `Task Reminder: ${taskInfo?.title || 'Pending Action'}`,
          message: `Reminder: Lead ${leadInfo.name} has a pending action for task "${taskInfo?.title}". ${message}`,
          htmlContent: generateTeamReminderHtml({
            leadName: leadInfo.name || 'Unknown Lead',
            leadEmail: leadInfo.email || 'No email',
            message,
            siteName: siteInfo.name || 'Unknown Site',
            taskTitle: taskInfo?.title,
            taskDescription: taskInfo?.description,
            status,
            priority,
            taskUrl,
            additionalData: additional_data,
            logoUrl: siteInfo.logo_url,
            primaryCta,
            reminderContext
          }),
          priority: priority as any,
          type: notificationType,
          categories: ['task-reminder', 'cta-reminder'],
          customArgs: {
            taskId: task_id,
            leadId: lead_id,
            notificationType: notification_type,
            ctaUrl: primaryCta.url
          },
          relatedEntityType: 'task',
          relatedEntityId: task_id
        });
        
        if (teamNotificationResult.success) {
          results.notifications_sent.team = teamNotificationResult.notificationsSent;
          results.emails_sent.team = teamNotificationResult.emailsSent;
          console.log(`✅ [TaskReminder] Equipo notificado: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
        } else {
          const errorMsg = `Failed to notify team: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`;
          results.errors.push(errorMsg);
          console.error(`❌ [TaskReminder] ${errorMsg}`);
        }
      } catch (error) {
        const errorMsg = `Error notifying team: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.errors.push(errorMsg);
        console.error(`❌ [TaskReminder] ${errorMsg}`, error);
      }
    }
    
    // 2. Enviar recordatorio al lead si está habilitado y tiene email
    if (include_lead && leadInfo.email) {
      console.log(`📧 [TaskReminder] Enviando recordatorio al lead: ${leadInfo.email}`);
      
      try {
        const leadEmailResult = await sendGridService.sendEmail({
          to: leadInfo.email,
          subject: `⏰ Friendly Reminder: ${taskInfo?.title || 'Action Required'} - ${siteInfo.name || 'Notification'}`,
          html: generateLeadReminderHtml({
            leadName: leadInfo.name || 'Dear Customer',
            message,
            siteName: siteInfo.name || 'Our Team',
            taskTitle: taskInfo?.title,
            taskDescription: taskInfo?.description,
            status,
            priority,
            siteUrl,
            logoUrl: siteInfo.logo_url,
            primaryCta,
            reminderContext
          }),
          categories: ['task-reminder', 'cta-reminder', 'lead-notification', 'transactional'],
          customArgs: {
            siteId: site_id,
            leadId: lead_id,
            taskId: task_id,
            notificationType: notification_type,
            ctaUrl: primaryCta.url
          }
        });
        
        if (leadEmailResult.success) {
          results.emails_sent.lead = 1;
          console.log(`✅ [TaskReminder] Lead notificado exitosamente: ${leadInfo.email}`);
        } else {
          const errorMsg = `Failed to notify lead: ${leadEmailResult.error}`;
          results.errors.push(errorMsg);
          console.error(`❌ [TaskReminder] ${errorMsg}`);
        }
      } catch (error) {
        const errorMsg = `Error notifying lead: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.errors.push(errorMsg);
        console.error(`❌ [TaskReminder] ${errorMsg}`, error);
      }
    } else if (include_lead && !leadInfo.email) {
      const errorMsg = 'Lead reminder requested but lead has no email';
      results.errors.push(errorMsg);
      console.warn(`⚠️ [TaskReminder] ${errorMsg}`);
    }
    
    // Determinar el éxito general
    const totalNotificationsSent = results.notifications_sent.team + results.notifications_sent.lead;
    const totalEmailsSent = results.emails_sent.team + results.emails_sent.lead;
    const hasNotifications = totalNotificationsSent > 0 || totalEmailsSent > 0;
    
    results.success = hasNotifications && results.errors.length === 0;
    
    console.log(`📊 [TaskReminder] Resumen de recordatorios:`, {
      success: results.success,
      team_notifications: results.notifications_sent.team,
      team_emails: results.emails_sent.team,
      lead_emails: results.emails_sent.lead,
      errors: results.errors.length,
      cta_title: primaryCta.title,
      cta_url: primaryCta.url
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
        task_info: {
          id: taskInfo.id,
          title: taskInfo.title,
          description: taskInfo.description,
          type: taskInfo.type,
          status: taskInfo.status,
          stage: taskInfo.stage,
          priority: taskInfo.priority
        },
        cta_info: {
          title: primaryCta.title,
          url: primaryCta.url,
          comment_id: lastCommentWithCTA.id
        },
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
    console.error('❌ [TaskReminder] Error general:', error);
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