import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const LeadAttentionSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  names: z.array(z.string().min(1, 'Name cannot be empty')).min(1, 'At least one name is required'),
  user_message: z.string().optional(),
  system_message: z.string().optional(),
  channel: z.enum(['email', 'whatsapp', 'phone', 'chat', 'form', 'other']).default('other'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  contact_info: z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    contact_method: z.string().optional()
  }).optional(),
  additional_data: z.record(z.any()).optional()
});

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener leads por nombres en un sitio específico
async function getLeadsByNames(siteId: string, names: string[]): Promise<any[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('site_id', siteId)
      .in('name', names)
      .not('assignee_id', 'is', null); // Solo leads asignados
    
    if (error) {
      console.error('Error al obtener leads por nombres:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error al obtener leads por nombres:', error);
    return [];
  }
}

// Función para obtener información completa del lead incluyendo assignee
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

// Función para obtener información del team member desde auth
async function getTeamMemberInfo(userId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    
    if (error) {
      console.error('Error al obtener información del team member:', error);
      return null;
    }
    
    if (!data.user) {
      console.error('Team member no encontrado');
      return null;
    }
    
    // Extraer información del metadata
    const metadata = data.user.user_metadata || {};
    
    const teamMemberInfo = {
      id: data.user.id,
      email: data.user.email,
      name: metadata.name || metadata.full_name || 'Team Member',
      role: metadata.role || 'team_member',
      avatar_url: metadata.avatar_url || null,
      notification_preferences: metadata.notification_preferences || {}
    };
    
    console.log(`👤 [LeadAttention] Team member encontrado: ${teamMemberInfo.name}`);
    return teamMemberInfo;
  } catch (error) {
    console.error('Error al obtener información del team member:', error);
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

// Función para verificar configuración de canales del sitio
async function checkSiteChannelsConfiguration(siteId: string): Promise<{
  hasChannels: boolean,
  configuredChannels: string[],
  warning?: string
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    if (error || !data?.channels) {
      const warning = `⚠️ [LeadAttention] CRITICAL: Site ${siteId} has NO channels configured in settings. Prospecting will be SERIOUSLY AFFECTED without at least one channel configuration.`;
      console.warn(warning);
      
      return {
        hasChannels: false,
        configuredChannels: [],
        warning: 'No channels configured - prospecting will be seriously affected'
      };
    }
    
    const channels = data.channels;
    const configuredChannels: string[] = [];
    
    // Verificar cada tipo de canal disponible
    if (channels.email && (channels.email.email || channels.email.aliases)) {
      configuredChannels.push('email');
    }
    
    if (channels.whatsapp && channels.whatsapp.phone_number) {
      configuredChannels.push('whatsapp');
    }
    
    if (channels.phone && channels.phone.number) {
      configuredChannels.push('phone');
    }
    
    if (channels.sms && channels.sms.phone_number) {
      configuredChannels.push('sms');
    }
    
    if (channels.chat && channels.chat.enabled) {
      configuredChannels.push('chat');
    }
    
    if (channels.social && (channels.social.facebook || channels.social.twitter || channels.social.linkedin)) {
      configuredChannels.push('social');
    }
    
    if (configuredChannels.length === 0) {
      const warning = `⚠️ [LeadAttention] CRITICAL: Site ${siteId} has channels object but NO FUNCTIONAL channels configured. Available channels: ${Object.keys(channels).join(', ')}. Prospecting will be SERIOUSLY AFFECTED without at least one functional channel.`;
      console.warn(warning);
      
      return {
        hasChannels: false,
        configuredChannels: [],
        warning: 'Channels object exists but no functional channels configured - prospecting will be seriously affected'
      };
    }
    
    console.log(`✅ [LeadAttention] Site ${siteId} has ${configuredChannels.length} channels configured: ${configuredChannels.join(', ')}`);
    
    return {
      hasChannels: true,
      configuredChannels,
      warning: undefined
    };
    
  } catch (error) {
    console.error('Error al verificar configuración de canales del sitio:', error);
    const warning = `⚠️ [LeadAttention] ERROR: Could not verify channels configuration for site ${siteId}. Prospecting may be affected.`;
    console.warn(warning);
    
    return {
      hasChannels: false,
      configuredChannels: [],
      warning: 'Could not verify channels configuration - prospecting may be affected'
    };
  }
}

// Funciones de branding consistentes
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Función para generar HTML del email para el team member
function generateTeamMemberNotificationHtml(data: {
  teamMemberName: string;
  leadName: string;
  leadEmail: string;
  userMessage?: string;
  systemMessage?: string;
  siteName: string;
  channel: string;
  priority: string;
  contactInfo?: {
    email?: string;
    phone?: string;
    contact_method?: string;
  };
  additionalData?: any;
  logoUrl?: string;
  leadUrl?: string;
  chatUrl?: string;
  replyEmail?: string;
}): string {
  const channelIcons = {
    email: '📧',
    whatsapp: '📱',
    phone: '☎️',
    chat: '💬',
    form: '📝',
    other: '🔔'
  };
  
  const channelNames = {
    email: 'Email',
    whatsapp: 'WhatsApp',
    phone: 'Phone',
    chat: 'Chat',
    form: 'Form',
    other: 'Other'
  };
  
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', badge: '#e0f2fe' },
    normal: { bg: '#f8fafc', color: '#334155', badge: '#e2e8f0' },
    high: { bg: '#fff7ed', color: '#c2410c', badge: '#fed7aa' },
    urgent: { bg: '#fef2f2', color: '#dc2626', badge: '#fecaca' }
  };
  
  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors] || priorityColors.normal;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Lead Attention Required - ${data.siteName}</title>
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
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 24px;">🔔</div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Lead Attention Required</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Your assigned lead needs attention</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Greeting -->
          <div style="margin-bottom: 32px;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              Hello ${data.teamMemberName}
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              Your assigned lead <strong>${data.leadName}</strong> has contacted you through <strong>${channelNames[data.channel as keyof typeof channelNames]}</strong> and requires your attention.
            </p>
          </div>
          
          <!-- Priority Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${priorityColor.badge}; color: ${priorityColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.priority} Priority
            </div>
          </div>
          
          <!-- Channel Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Contact Information</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Channel:</span>
                <span style="color: #1e293b; font-size: 15px;">
                  ${channelIcons[data.channel as keyof typeof channelIcons]} ${channelNames[data.channel as keyof typeof channelNames]}
                </span>
              </div>
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Name:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
              </div>
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Email:</span>
                <a href="mailto:${data.leadEmail}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">
                  ${data.leadEmail}
                </a>
              </div>
              ${data.contactInfo?.phone ? `
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Phone:</span>
                <a href="tel:${data.contactInfo.phone}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">
                  ${data.contactInfo.phone}
                </a>
              </div>
              ` : ''}
              ${data.contactInfo?.contact_method ? `
              <div>
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Method:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.contactInfo.contact_method}</span>
              </div>
              ` : ''}
            </div>
          </div>
          
          <!-- Messages -->
          ${data.userMessage || data.systemMessage ? `
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Messages</h3>
            ${data.userMessage ? `
            <div style="margin-bottom: 16px;">
              <h4 style="margin: 0 0 8px; font-size: 16px; color: #3b82f6; font-weight: 600;">User Message</h4>
              <div style="background-color: #f1f5f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                  ${data.userMessage}
                </div>
              </div>
            </div>
            ` : ''}
            ${data.systemMessage ? `
            <div style="margin-bottom: 16px;">
              <h4 style="margin: 0 0 8px; font-size: 16px; color: #f59e0b; font-weight: 600;">System Message</h4>
              <div style="background-color: #fff7ed; padding: 24px; border-radius: 8px; border: 1px solid #fed7aa;">
                <div style="color: #1e293b; font-size: 16px; line-height: 1.7;">
                  ${data.systemMessage}
                </div>
              </div>
            </div>
            ` : ''}
          </div>
          ` : ''}
          
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
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            ${data.leadUrl ? `
            <a href="${data.leadUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">
              View Lead →
            </a>
            ` : ''}
            ${data.chatUrl ? `
            <a href="${data.chatUrl}" 
               style="display: inline-block; background: #ffffff; color: #f59e0b; border: 2px solid #f59e0b; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
              Reply to Lead →
            </a>
            ` : ''}
          </div>
          
          <!-- Urgency Notice -->
          ${data.priority === 'urgent' || data.priority === 'high' ? `
          <div style="margin-top: 32px; padding: 16px 24px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; text-align: center;">
            <p style="margin: 0; color: #dc2626; font-size: 14px; font-weight: 600;">
              ⚠️ This lead requires ${data.priority === 'urgent' ? 'URGENT' : 'HIGH PRIORITY'} attention
            </p>
          </div>
          ` : ''}
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              This lead has been assigned to you and contacted through <strong style="color: #475569;">${channelNames[data.channel as keyof typeof channelNames]}</strong>.<br>
              Please respond as soon as possible to maintain engagement.
            </p>
          </div>
          
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
          Powered by <strong style="color: #f59e0b;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('🔔 [LeadAttention] Iniciando notificación de lead que requiere atención');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = LeadAttentionSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [LeadAttention] Error de validación:', validationResult.error.errors);
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
      names,
      user_message,
      system_message,
      channel,
      priority,
      contact_info,
      additional_data
    } = validationResult.data;
    
    console.log(`👤 [LeadAttention] Procesando notificación para leads: ${names.join(', ')}, sitio: ${site_id}`);
    
    // Obtener leads por nombres en el sitio
    const leads = await getLeadsByNames(site_id, names);
    
    if (leads.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'LEADS_NOT_FOUND',
            message: 'No leads found with the provided names'
          }
        },
        { status: 404 }
      );
    }

    // Obtener el site_id del primer lead para usarlo en las URLs
    const firstLead = leads[0];
    const siteId = firstLead.site_id;

    // Obtener información del sitio
    const siteInfo = await getSiteInfo(siteId);
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

         // Verificar configuración de canales del sitio (solo warning, no bloquea el proceso)
     const channelsConfig = await checkSiteChannelsConfiguration(siteId);

     // Obtener configuración de email del sitio
    const siteEmailConfig = await getSiteEmailConfig(siteId);
    const replyEmail = siteEmailConfig.aliases.length > 0 ? siteEmailConfig.aliases[0] : siteEmailConfig.email;
    
    console.log(`📧 [LeadAttention] Configuración de email del sitio:`, {
      email: siteEmailConfig.email,
      aliases: siteEmailConfig.aliases,
      replyEmail
    });
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const siteUrl = siteInfo.url || `${baseUrl}/sites/${siteId}`;
    
    console.log(`📧 [LeadAttention] Enviando notificaciones a team members para los leads:`);
    for (const lead of leads) {
      const leadId = lead.id;
      const assigneeId = lead.assignee_id;

      if (!assigneeId) {
        console.warn(`⚠️ [LeadAttention] Lead ${leadId} has no assigned team member, skipping.`);
        continue;
      }

      console.log(`📧 [LeadAttention] Notificando a team member ${assigneeId} para el lead ${leadId}`);
      
      try {
        const teamMemberInfo = await getTeamMemberInfo(assigneeId);
        if (!teamMemberInfo) {
          console.error(`❌ [LeadAttention] Team member ${assigneeId} not found.`);
          continue;
        }

        if (!teamMemberInfo.email) {
          console.warn(`⚠️ [LeadAttention] Team member ${assigneeId} has no email address, skipping.`);
          continue;
        }

        const leadInfo = await getLeadInfo(leadId);
        if (!leadInfo) {
          console.error(`❌ [LeadAttention] Lead ${leadId} not found.`);
          continue;
        }

        const channelNames = {
          email: 'Email',
          whatsapp: 'WhatsApp',
          phone: 'Phone',
          chat: 'Chat',
          form: 'Form',
          other: 'Other'
        };
        
        const emailResult = await sendGridService.sendEmail({
          to: teamMemberInfo.email,
          subject: `🔔 Lead Attention Required: ${leadInfo.name || 'New Lead'} contacted you via ${channelNames[channel]}`,
          html: generateTeamMemberNotificationHtml({
            teamMemberName: teamMemberInfo.name || 'Team Member',
            leadName: leadInfo.name || 'Unknown Lead',
            leadEmail: leadInfo.email || 'No email',
            userMessage: user_message,
            systemMessage: system_message,
            siteName: siteInfo.name || 'Unknown Site',
            channel,
            priority,
            contactInfo: contact_info,
            additionalData: additional_data,
            logoUrl: siteInfo.logo_url,
            leadUrl: `${siteUrl}/leads/${leadId}`,
            chatUrl: `${baseUrl}/sites/${siteId}/chat`,
            replyEmail: replyEmail || undefined
          }),
          categories: ['lead-attention', 'team-notification', 'priority-' + priority],
          customArgs: {
            siteId: siteId,
            leadId: leadId,
            teamMemberId: assigneeId,
            channel,
            priority
          }
        });
        
        if (emailResult.success) {
          console.log(`✅ [LeadAttention] Team member ${assigneeId} notificado exitosamente para el lead ${leadId}`);
        } else {
          console.error(`❌ [LeadAttention] Error enviando email a team member ${assigneeId} para el lead ${leadId}: ${emailResult.error}`);
        }
      } catch (error) {
        console.error(`❌ [LeadAttention] Error enviando notificación para el lead ${leadId}:`, error);
      }
    }
    
         return NextResponse.json({
       success: true,
       data: {
         site_id,
         names,
         channel,
         priority,
         notification_sent: true,
         sent_at: new Date().toISOString(),
         channels_configuration: {
           has_channels: channelsConfig.hasChannels,
           configured_channels: channelsConfig.configuredChannels,
           warning: channelsConfig.warning
         }
       }
     });
    
  } catch (error) {
    console.error('❌ [LeadAttention] Error general:', error);
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