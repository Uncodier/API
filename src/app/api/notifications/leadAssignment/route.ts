import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const LeadAssignmentSchema = z.object({
  lead_id: z.string().uuid('lead_id debe ser un UUID válido'),
  assignee_id: z.string().uuid('assignee_id debe ser un UUID válido'),
  brief: z.string().min(1, 'brief es requerido'),
  next_steps: z.array(z.string()).min(1, 'next_steps debe contener al menos un paso'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_date: z.string().optional(),
  additional_context: z.string().optional(),
  include_team_notification: z.boolean().default(false),
  metadata: z.record(z.any()).optional()
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
      .select(`
        id,
        name,
        email,
        phone,
        position,
        status,
        notes,
        origin,
        site_id,
        assignee_id,
        company,
        created_at,
        updated_at,
        last_contact
      `)
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

// Función para obtener información del vendedor asignado
async function getAssigneeInfo(assigneeId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select(`
        id,
        email,
        name,
        raw_user_meta_data
      `)
      .eq('id', assigneeId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del vendedor:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del vendedor:', error);
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

// Función para actualizar el assignee_id del lead
async function updateLeadAssignee(leadId: string, assigneeId: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('leads')
      .update({
        assignee_id: assigneeId,
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId);
    
    if (error) {
      console.error('Error al actualizar assignee del lead:', error);
      return false;
    }
    
    console.log(`✅ Lead ${leadId} asignado a vendedor ${assigneeId}`);
    return true;
  } catch (error) {
    console.error('Error al actualizar assignee del lead:', error);
    return false;
  }
}

// Funciones de branding consistentes
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Función para generar HTML del email para el vendedor
function generateAssigneeNotificationHtml(data: {
  assigneeName: string;
  leadName: string;
  leadEmail?: string;
  leadPhone?: string;
  leadPosition?: string;
  leadCompany?: string;
  leadStatus: string;
  leadOrigin?: string;
  brief: string;
  nextSteps: string[];
  priority: string;
  dueDate?: string;
  additionalContext?: string;
  siteName: string;
  siteUrl?: string;
  leadUrl?: string;
  logoUrl?: string;
  replyEmail?: string;
}): string {
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', border: '#7dd3fc' },
    normal: { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    high: { bg: '#fef3c7', color: '#d97706', border: '#fde047' },
    urgent: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' }
  };
  
  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors];
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Lead Assignment - ${data.siteName}</title>
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
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Lead Assignment</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">You have a new lead to work with</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Greeting -->
          <div style="margin-bottom: 32px;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              Hello ${data.assigneeName}
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              You have been assigned a new lead from ${data.siteName}. Please review the information below and take the necessary next steps.
            </p>
          </div>
          
          <!-- Priority Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${priorityColor.bg}; color: ${priorityColor.color}; border: 1px solid ${priorityColor.border}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.priority} Priority
            </div>
          </div>
          
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Lead Information</h3>
            <div style="background-color: #f8fafc; padding: 24px; border-radius: 8px; border-left: 4px solid #10b981;">
              <div style="display: grid; gap: 12px;">
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Name:</span>
                  <span style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
                </div>
                ${data.leadEmail ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Email:</span>
                  <a href="mailto:${data.leadEmail}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">${data.leadEmail}</a>
                </div>
                ` : ''}
                ${data.leadPhone ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Phone:</span>
                  <a href="tel:${data.leadPhone}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">${data.leadPhone}</a>
                </div>
                ` : ''}
                ${data.leadPosition ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Position:</span>
                  <span style="color: #1e293b; font-size: 15px;">${data.leadPosition}</span>
                </div>
                ` : ''}
                ${data.leadCompany ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Company:</span>
                  <span style="color: #1e293b; font-size: 15px;">${data.leadCompany}</span>
                </div>
                ` : ''}
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Status:</span>
                  <span style="color: #1e293b; font-size: 15px; text-transform: capitalize;">${data.leadStatus}</span>
                </div>
                ${data.leadOrigin ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #10b981; min-width: 80px;">Origin:</span>
                  <span style="color: #1e293b; font-size: 15px; text-transform: capitalize;">${data.leadOrigin}</span>
                </div>
                ` : ''}
              </div>
            </div>
          </div>
          
          <!-- Brief -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Brief</h3>
            <div style="background-color: #eff6ff; padding: 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                ${data.brief}
              </div>
            </div>
          </div>
          
          <!-- Next Steps -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Next Steps</h3>
            <div style="background-color: #f0fdf4; padding: 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul style="margin: 0; padding: 0 0 0 20px; color: #1e293b; font-size: 15px; line-height: 1.7;">
                ${data.nextSteps.map(step => `<li style="margin-bottom: 8px;">${step}</li>`).join('')}
              </ul>
            </div>
          </div>
          
          <!-- Due Date -->
          ${data.dueDate ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Due Date</h3>
            <div style="background-color: #fef3c7; padding: 20px 24px; border-radius: 8px; border: 1px solid #fde047;">
              <div style="color: #92400e; font-size: 16px; font-weight: 600;">
                📅 ${new Date(data.dueDate).toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}
              </div>
            </div>
          </div>
          ` : ''}
          
          <!-- Additional Context -->
          ${data.additionalContext ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Additional Context</h3>
            <div style="background-color: #f8fafc; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div style="color: #475569; font-size: 15px; line-height: 1.7;">
                ${data.additionalContext}
              </div>
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            ${data.leadUrl ? `
            <a href="${data.leadUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">
              View Lead Details →
            </a>
            ` : ''}
            ${data.replyEmail ? `
            <a href="mailto:${data.replyEmail}" 
               style="display: inline-block; background: #ffffff; color: #10b981; border: 2px solid #10b981; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
              Reply →
            </a>
            ` : ''}
            ${data.siteUrl ? `
            <a href="${data.siteUrl}" 
               style="display: inline-block; background: #ffffff; color: #10b981; border: 2px solid #10b981; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
              Visit Site →
            </a>
            ` : ''}
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            This lead assignment was automatically generated by ${getCompanyName()}.<br>
            Please contact your manager if you have any questions about this assignment.
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

// Función para generar HTML del email para el equipo (notificación interna)
function generateTeamNotificationHtml(data: {
  leadName: string;
  leadEmail?: string;
  assigneeName: string;
  assigneeEmail: string;
  brief: string;
  nextSteps: string[];
  priority: string;
  siteName: string;
  dueDate?: string;
  leadUrl?: string;
  logoUrl?: string;
}): string {
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', border: '#7dd3fc' },
    normal: { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    high: { bg: '#fef3c7', color: '#d97706', border: '#fde047' },
    urgent: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' }
  };
  
  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors];
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Lead Assignment Notification - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #3b82f6; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Lead Assignment</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Team notification</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Priority Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${priorityColor.bg}; color: ${priorityColor.color}; border: 1px solid ${priorityColor.border}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.priority} Priority
            </div>
          </div>
          
          <!-- Assignment Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Assignment Details</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Lead:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
                ${data.leadEmail ? `<span style="color: #64748b; font-size: 14px; margin-left: 8px;">(${data.leadEmail})</span>` : ''}
              </div>
              <div>
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Assigned to:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.assigneeName}</span>
                <span style="color: #64748b; font-size: 14px; margin-left: 8px;">(${data.assigneeEmail})</span>
              </div>
            </div>
          </div>
          
          <!-- Brief -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Brief</h3>
            <div style="background-color: #f1f5f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                ${data.brief}
              </div>
            </div>
          </div>
          
          <!-- Next Steps -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Next Steps</h3>
            <div style="background-color: #f0fdf4; padding: 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul style="margin: 0; padding: 0 0 0 20px; color: #1e293b; font-size: 15px; line-height: 1.7;">
                ${data.nextSteps.map(step => `<li style="margin-bottom: 8px;">${step}</li>`).join('')}
              </ul>
            </div>
          </div>
          
          <!-- Due Date -->
          ${data.dueDate ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Due Date</h3>
            <div style="background-color: #fef3c7; padding: 20px 24px; border-radius: 8px; border: 1px solid #fde047;">
              <div style="color: #92400e; font-size: 16px; font-weight: 600;">
                📅 ${new Date(data.dueDate).toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}
              </div>
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          ${data.leadUrl ? `
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.leadUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">
              View Lead Details →
            </a>
          </div>
          ` : ''}
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            This notification was automatically generated by ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong style="color: #3b82f6;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('👨‍💼 [LeadAssignment] Iniciando notificación de asignación de lead');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = LeadAssignmentSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [LeadAssignment] Error de validación:', validationResult.error.errors);
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
      lead_id,
      assignee_id,
      brief,
      next_steps,
      priority,
      due_date,
      additional_context,
      include_team_notification,
      metadata
    } = validationResult.data;
    
    console.log(`🎯 [LeadAssignment] Procesando asignación de lead: ${lead_id} a vendedor: ${assignee_id}`);
    
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
    
    // Obtener información del vendedor
    const assigneeInfo = await getAssigneeInfo(assignee_id);
    if (!assigneeInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'ASSIGNEE_NOT_FOUND',
            message: 'Assignee not found'
          }
        },
        { status: 404 }
      );
    }
    
    // Obtener información del sitio
    const siteInfo = await getSiteInfo(leadInfo.site_id);
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
    const siteEmailConfig = await getSiteEmailConfig(leadInfo.site_id);
    const replyEmail = siteEmailConfig.aliases.length > 0 ? siteEmailConfig.aliases[0] : siteEmailConfig.email;
    
    console.log(`📧 [LeadAssignment] Configuración de email del sitio:`, {
      email: siteEmailConfig.email,
      aliases: siteEmailConfig.aliases,
      replyEmail
    });
    
    // Actualizar el assignee_id del lead en la base de datos
    const updateSuccess = await updateLeadAssignee(lead_id, assignee_id);
    if (!updateSuccess) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'ASSIGNMENT_UPDATE_FAILED',
            message: 'Failed to update lead assignment'
          }
        },
        { status: 500 }
      );
    }
    
    const results = {
      success: true,
      notifications_sent: {
        assignee: 0,
        team: 0
      },
      emails_sent: {
        assignee: 0,
        team: 0
      },
      errors: [] as string[]
    };
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const leadUrl = `${baseUrl}/leads/${lead_id}`;
    const siteUrl = siteInfo.url || `${baseUrl}/dashboard`;
    
    // 1. Notificar al vendedor asignado
    console.log(`📧 [LeadAssignment] Enviando notificación al vendedor: ${assigneeInfo.email}`);
    
    try {
      const assigneeEmailResult = await sendGridService.sendEmail({
        to: assigneeInfo.email,
        subject: `New Lead Assignment: ${leadInfo.name} - ${siteInfo.name || 'Lead Assignment'}`,
        html: generateAssigneeNotificationHtml({
          assigneeName: assigneeInfo.name || assigneeInfo.email,
          leadName: leadInfo.name,
          leadEmail: leadInfo.email,
          leadPhone: leadInfo.phone,
          leadPosition: leadInfo.position,
          leadCompany: leadInfo.company,
          leadStatus: leadInfo.status,
          leadOrigin: leadInfo.origin,
          brief,
          nextSteps: next_steps,
          priority,
          dueDate: due_date,
          additionalContext: additional_context,
          siteName: siteInfo.name || 'Lead Assignment',
          siteUrl,
          leadUrl,
          logoUrl: siteInfo.logo_url,
          replyEmail: replyEmail || undefined
        }),
        categories: ['lead-assignment', 'assignee-notification', 'transactional'],
        customArgs: {
          siteId: leadInfo.site_id,
          leadId: lead_id,
          assigneeId: assignee_id,
          notificationType: 'lead_assignment',
          priority,
          metadata: metadata ? JSON.stringify(metadata) : ''
        }
      });
      
      if (assigneeEmailResult.success) {
        results.emails_sent.assignee = 1;
        console.log(`✅ [LeadAssignment] Vendedor notificado exitosamente: ${assigneeInfo.email}`);
      } else {
        const errorMsg = `Failed to notify assignee: ${assigneeEmailResult.error}`;
        results.errors.push(errorMsg);
        console.error(`❌ [LeadAssignment] ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = `Error notifying assignee: ${error instanceof Error ? error.message : 'Unknown error'}`;
      results.errors.push(errorMsg);
      console.error(`❌ [LeadAssignment] ${errorMsg}`, error);
    }
    
    // 2. Notificar al equipo si está habilitado
    if (include_team_notification) {
      console.log('📢 [LeadAssignment] Notificando al equipo...');
      
      try {
        const teamNotificationResult = await TeamNotificationService.notifyTeam({
          siteId: leadInfo.site_id,
          title: `Lead Assignment: ${leadInfo.name} assigned to ${assigneeInfo.name}`,
          message: `New lead assignment: ${leadInfo.name} has been assigned to ${assigneeInfo.name || assigneeInfo.email}`,
          htmlContent: generateTeamNotificationHtml({
            leadName: leadInfo.name,
            leadEmail: leadInfo.email,
            assigneeName: assigneeInfo.name || assigneeInfo.email,
            assigneeEmail: assigneeInfo.email,
            brief,
            nextSteps: next_steps,
            priority,
            siteName: siteInfo.name || 'Lead Assignment',
            dueDate: due_date,
            leadUrl,
            logoUrl: siteInfo.logo_url
          }),
          priority: priority as any,
          type: NotificationType.INFO,
          categories: ['lead-assignment', 'team-notification'],
          customArgs: {
            leadId: lead_id,
            assigneeId: assignee_id,
            notificationType: 'lead_assignment'
          },
          relatedEntityType: 'lead',
          relatedEntityId: lead_id
        });
        
        if (teamNotificationResult.success) {
          results.notifications_sent.team = teamNotificationResult.notificationsSent;
          results.emails_sent.team = teamNotificationResult.emailsSent;
          console.log(`✅ [LeadAssignment] Equipo notificado: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
        } else {
          const errorMsg = `Failed to notify team: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`;
          results.errors.push(errorMsg);
          console.error(`❌ [LeadAssignment] ${errorMsg}`);
        }
      } catch (error) {
        const errorMsg = `Error notifying team: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.errors.push(errorMsg);
        console.error(`❌ [LeadAssignment] ${errorMsg}`, error);
      }
    }
    
    // Determinar el éxito general
    const totalNotificationsSent = results.notifications_sent.assignee + results.notifications_sent.team;
    const totalEmailsSent = results.emails_sent.assignee + results.emails_sent.team;
    const hasNotifications = totalNotificationsSent > 0 || totalEmailsSent > 0;
    
    results.success = hasNotifications && results.errors.length === 0;
    
    console.log(`📊 [LeadAssignment] Resumen de notificaciones:`, {
      success: results.success,
      assignee_emails: results.emails_sent.assignee,
      team_notifications: results.notifications_sent.team,
      team_emails: results.emails_sent.team,
      errors: results.errors.length
    });
    
    return NextResponse.json({
      success: results.success,
      data: {
        lead_id,
        assignee_id,
        lead_info: {
          name: leadInfo.name,
          email: leadInfo.email,
          phone: leadInfo.phone,
          status: leadInfo.status,
          origin: leadInfo.origin
        },
        assignee_info: {
          name: assigneeInfo.name,
          email: assigneeInfo.email
        },
        site_info: {
          name: siteInfo.name,
          url: siteInfo.url
        },
        assignment_details: {
          brief,
          next_steps,
          priority,
          due_date,
          additional_context
        },
        notifications_sent: results.notifications_sent,
        emails_sent: results.emails_sent,
        total_recipients: {
          assignee: results.emails_sent.assignee,
          team: results.notifications_sent.team
        },
        assignment_updated: updateSuccess,
        errors: results.errors.length > 0 ? results.errors : undefined,
        sent_at: new Date().toISOString()
      }
    }, { 
      status: results.success ? 200 : (results.errors.length > 0 ? 207 : 500) // 207 = Multi-Status (partial success)
    });
    
  } catch (error) {
    console.error('❌ [LeadAssignment] Error general:', error);
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