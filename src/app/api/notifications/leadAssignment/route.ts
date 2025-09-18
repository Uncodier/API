import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { generateAssigneeNotificationHtml, generateTeamNotificationHtml, formatLeadOrigin } from '@/lib/emails/lead-assignment';
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
        company_id,
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

// Función para obtener información de la compañía
async function getCompanyInfo(companyId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('companies')
      .select(`id, name, website, logo_url`)
      .eq('id', companyId)
      .single();

    if (error) {
      console.error('Error al obtener información de la compañía:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error al obtener información de la compañía:', error);
    return null;
  }
}

// Extrae el nombre de la compañía de diferentes formatos
function extractCompanyName(company: unknown): string | undefined {
  if (!company) return undefined;
  if (typeof company === 'string') return company || undefined;
  if (typeof company === 'object') {
    const anyCompany = company as Record<string, unknown>;
    if (typeof anyCompany.name === 'string' && anyCompany.name.trim().length > 0) {
      return anyCompany.name.trim();
    }
  }
  return undefined;
}

// Función para obtener información del vendedor asignado
async function getAssigneeInfo(assigneeId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select(`
        id,
        email,
        name,
        role,
        metadata
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
    
    // Resolver nombre de compañía (evitar enviar [object Object])
    let leadCompanyName: string | undefined = undefined;
    if (leadInfo.company_id && isValidUUID(String(leadInfo.company_id))) {
      const companyInfo = await getCompanyInfo(String(leadInfo.company_id));
      leadCompanyName = companyInfo?.name || undefined;
    }
    if (!leadCompanyName) {
      leadCompanyName = extractCompanyName(leadInfo.company);
    }

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
          leadCompany: leadCompanyName,
          leadStatus: leadInfo.status,
          leadOrigin: formatLeadOrigin(leadInfo.origin),
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
          origin: formatLeadOrigin(leadInfo.origin)
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