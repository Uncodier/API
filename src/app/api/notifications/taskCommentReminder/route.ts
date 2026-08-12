import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';
import { platformT } from '@/lib/i18n/email-messages/platform';

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

// Función para obtener la configuración de email del sitio
async function getSiteEmailConfig(siteId: string): Promise<{email: string | null, aliases: string[]}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    if (error || !data?.channels?.email) {
      return { email: null, aliases: [] };
    }
    
    const emailConfig = data.channels.email;
    let aliases: string[] = [];
    
    // Procesar aliases
    if (emailConfig.aliases) {
      if (Array.isArray(emailConfig.aliases)) {
        aliases = emailConfig.aliases;
      } else if (typeof emailConfig.aliases === 'string') {
        aliases = emailConfig.aliases
          .split(',')
          .map((alias: string) => alias.trim())
          .filter((alias: string) => alias.length > 0);
      }
    }
    
    return {
      email: emailConfig.email || null,
      aliases
    };
  } catch (error) {
    console.error('Error al obtener configuración de email del sitio:', error);
    return { email: null, aliases: [] };
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
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
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
  replyEmail?: string;
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
    <html lang="${data.locale || 'en'}">
    <head>
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
<style type="text/css">
        :root { color-scheme: light only; }

    .email-header {
      background-color: #1e1e2d !important;
      background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
    }
    .email-header-title,
    .email-header h1 {
      color: #f0f0f5 !important;
      -webkit-text-fill-color: #f0f0f5 !important;
    }
    .email-header-sub,
    .email-header p {
      color: #a1a1aa !important;
      -webkit-text-fill-color: #a1a1aa !important;
    }

    .email-card {
      background-color: #ffffff !important;
      background-image: linear-gradient(#ffffff, #ffffff) !important;
      color: #111111 !important;
    }

    .email-heading {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-text {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-muted,
    .email-subtle {
      color: #52525b !important;
      -webkit-text-fill-color: #52525b !important;
    }

    .email-panel {
      background-color: #f0f0f5 !important;
      background-image: linear-gradient(#f0f0f5, #f0f0f5) !important;
      border: 1px solid #e4e4e7 !important;
      color: #111111 !important;
    }
    .email-panel,
    .email-panel .email-text,
    .email-panel .email-heading,
    .email-panel div,
    .email-panel p,
    .email-panel span:not(.email-badge):not(.email-cta-label),
    .email-panel strong {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-code-box {
      background-color: #f4ffe5 !important;
      background-image: linear-gradient(#f4ffe5, #f4ffe5) !important;
      border: 1px solid #c6f08a !important;
    }
    .email-code-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
    }
    .email-code-value {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
      font-weight: 600 !important;
    }

    .email-badge {
      display: inline-block !important;
      background-color: #90ff17 !important;
      background-image: linear-gradient(#90ff17, #90ff17) !important;
      box-shadow: inset 0 0 0 999px #90ff17 !important;
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
      border: 0 !important;
    }

    .email-link {
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
    }

    .email-cta-td {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
    }
    .email-cta {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      border: 0 !important;
    }
    .email-cta-label,
    .email-cta span {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }
        
</style>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Friendly Reminder - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #90ff17; font-weight: 600; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">⏰ Friendly Reminder</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">You have a pending action</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Greeting -->
          <div style="margin-bottom: 32px;">
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #111111; font-weight: 600;">
              Hello ${data.leadName} 👋
            </h2>
            <p class="email-text" style="margin: 0; font-size: 16px; color: #111111; line-height: 1.7;">
              We hope you're doing well! This is a friendly reminder from ${data.siteName}.
            </p>
          </div>
          
          
          
          <!-- Task Information -->
          ${data.taskTitle ? `
          <div style="margin-bottom: 32px;">
            <div style="background-color: #f0fdfa; padding: 20px 24px; border-radius: 8px; border-left: 4px solid #90ff17;">
              <h3 class="email-heading" style="margin: 0 0 8px; font-size: 16px; color: #111111; font-weight: 600;">📋 ${data.taskTitle}</h3>
              ${data.taskDescription ? `<p class="email-text" style="margin: 0; color: #111111; font-size: 15px; line-height: 1.6;">${data.taskDescription}</p>` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Reminder Message -->
          <div style="margin-bottom: 32px;">
            <div style="background-color: #fef3c7; padding: 24px; border-radius: 8px; border: 1px solid #fde047;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #92400e; font-weight: 600;">📢 Reminder</h3>
              <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- Call-to-Action -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.primaryCta.url}" 
               class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 18px 36px; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 18px; letter-spacing: -0.025em; box-shadow: 0 8px 16px -4px rgba(16, 185, 129, 0.3); transition: transform 0.2s, box-shadow 0.2s; text-transform: uppercase;">
              🎯 ${data.primaryCta.title}
            </a>
          </div>
          
          <!-- Secondary Action -->
          ${data.replyEmail ? `
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="mailto:${data.replyEmail}" 
               style="color: #000000; font-weight: 600; text-decoration: none; font-size: 14px; font-weight: 500;">
              or reply to this email →
            </a>
          </div>
          ` : data.siteUrl ? `
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${data.siteUrl}" 
               style="color: #000000; font-weight: 600; text-decoration: none; font-size: 14px; font-weight: 500;">
              or visit our website →
            </a>
          </div>
          ` : ''}
          
          <!-- Context Note -->
          ${data.reminderContext ? `
          <div style="margin-top: 32px; padding: 16px; background-color: #f8fafc; border-radius: 6px; border-left: 3px solid #90ff17;">
            <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
              <strong class="email-text" style="color: #111111;">Context:</strong> ${data.reminderContext}
            </p>
          </div>
          ` : ''}
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
              This is a friendly reminder about your pending action. We're here to help if you have any questions!
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
            This reminder was sent by ${getCompanyName()}.<br>
            If you have any questions, feel free to reply to this message.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p class="email-subtle" style="margin: 0; color: #71717a; font-size: 12px;">
          Powered by <strong style="color: #000000;">${getBrandingText()}</strong>
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
  replyEmail?: string;
  locale?: string;
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
    <html lang="${data.locale || 'en'}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Task Reminder - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #90ff17; font-weight: 600; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">⏰ Task Reminder</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">Lead needs follow-up action</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          
          
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">👤 Lead Information</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 60px;">Name:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${data.leadName}</span>
              </div>
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 60px;">Email:</span>
                <a href="mailto:${data.leadEmail}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">
                  ${data.leadEmail}
                </a>
              </div>
            </div>
          </div>
          
          <!-- Task Information -->
          ${data.taskTitle ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">📋 Task Information</h3>
            <div style="background-color: #fefce8; padding: 20px 24px; border-radius: 8px; border-left: 4px solid #90ff17;">
              <h4 class="email-heading" style="margin: 0 0 8px; color: #111111; font-size: 15px; font-weight: 600;">${data.taskTitle}</h4>
              ${data.taskDescription ? `<p class="email-text" style="margin: 0; color: #111111; font-size: 14px; line-height: 1.6;">${data.taskDescription}</p>` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Reminder Message -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">📢 Reminder</h3>
            <div style="background-color: #fef3c7; padding: 24px; border-radius: 8px; border: 1px solid #fde047;">
              <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- CTA Information -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">🎯 Action Required</h3>
            <div style="background-color: #f0fdf4; padding: 20px 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <div style="margin-bottom: 16px;">
                <span style="display: inline-block; font-weight: 600; color: #16a34a; min-width: 80px;">Action:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${data.primaryCta.title}</span>
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
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">📊 Additional Information</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              ${Object.entries(data.additionalData).map(([key, value]) => `
                <div style="margin-bottom: 8px;">
                  <span class="email-text" style="display: inline-block; font-weight: 600; color: #111111; min-width: 100px; text-transform: capitalize;">${key.replace('_', ' ')}:</span>
                  <span class="email-text" style="color: #111111; font-size: 14px;">${typeof value === 'object' ? JSON.stringify(value) : value}</span>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Context Note -->
          ${data.reminderContext ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">📝 Context</h3>
            <div class="email-muted" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border-left: 3px solid #64748b;">
              <p class="email-text" style="margin: 0; color: #111111; font-size: 14px; line-height: 1.6;">
                ${data.reminderContext}
              </p>
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.primaryCta.url}" 
               class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">
              ${data.primaryCta.title} →
            </a>
            ${data.replyEmail ? `
            <a href="mailto:${data.replyEmail}" 
               style="display: inline-block; background: #ffffff; color: #000000; border: 2px solid #000000; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
              Reply →
            </a>
            ` : ''}
            ${data.taskUrl ? `
            <a href="${data.taskUrl}" 
               style="display: inline-block; background: #ffffff; color: #000000; border: 2px solid #000000; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
              View Task →
            </a>
            ` : ''}
          </div>
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
              This is an automated reminder about a pending task action for <strong class="email-text" style="color: #111111;">${data.leadName}</strong>
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
            This reminder was automatically generated by ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p class="email-subtle" style="margin: 0; color: #71717a; font-size: 12px;">
          Powered by <strong style="color: #000000;">${getBrandingText()}</strong>
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

    // Obtener configuración de email del sitio
    const siteEmailConfig = await getSiteEmailConfig(site_id);
    const replyEmail = siteEmailConfig.aliases.length > 0 ? siteEmailConfig.aliases[0] : siteEmailConfig.email;
    
    console.log(`📧 [TaskReminder] Configuración de email del sitio:`, {
      email: siteEmailConfig.email,
      aliases: siteEmailConfig.aliases,
      replyEmail
    });
    
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
    const taskUrl = `${baseUrl}/control-center/${task_id}`;
    const siteUrl = siteInfo.url || `${baseUrl}/dashboard`;
    
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
          buildEmail: (locale) => ({
            subject: platformT(locale, 'task_reminder.subject', { taskTitle: taskInfo?.title || 'Pending Action', siteName: siteInfo.name || 'Unknown Site' }),
            html: generateTeamReminderHtml({
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
              reminderContext,
              replyEmail: replyEmail || undefined,
              locale
            }),
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
          subject: (await import('@/lib/i18n/email-messages/platform')).platformT(
            await (await import('@/lib/i18n/email-locale')).resolveEmailLocale({
              siteId: site_id,
              userId: lead_id,
            }),
            'task_reminder.subject',
            { taskTitle: taskInfo?.title || 'Action Required', siteName: siteInfo.name || 'Notification' }
          ),
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
            reminderContext,
            replyEmail: replyEmail || undefined
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