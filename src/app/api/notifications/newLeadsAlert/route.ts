import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const NewLeadsAlertSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  hours_until_auto_prospect: z.number().min(1).max(168).default(48), // Entre 1 hora y 1 semana
  include_lead_details: z.boolean().default(true),
  max_leads_to_display: z.number().min(1).max(50).default(20)
});

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener leads nuevos sin asignar creados en las últimas 24 horas
async function getUnassignedNewLeads(siteId: string, maxLeads: number = 20): Promise<any[]> {
  try {
    console.log(`🔍 [NewLeadsAlert] Buscando leads nuevos sin asignar creados en las últimas 24 horas para sitio: ${siteId}`);
    
    // Calcular fecha de hace 24 horas
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    const timeFilter = twentyFourHoursAgo.toISOString();
    
    console.log(`⏰ [NewLeadsAlert] Buscando leads creados después de: ${timeFilter}`);
    
    const { data: leads, error } = await supabaseAdmin
      .from('leads')
      .select(`
        id,
        name,
        email,
        phone,
        company,
        status,
        origin,
        created_at,
        segments!inner(id, name, description)
      `)
      .eq('site_id', siteId)
      .eq('status', 'new')
      .is('assignee_id', null)
      .gte('created_at', timeFilter)
      .order('created_at', { ascending: false })
      .limit(maxLeads);
    
    if (error) {
      console.error('Error al obtener leads sin asignar:', error);
      return [];
    }
    
    if (!leads || leads.length === 0) {
      console.log('⚠️ No se encontraron leads nuevos sin asignar en las últimas 24 horas');
      return [];
    }
    
    console.log(`✅ Encontrados ${leads.length} leads nuevos sin asignar creados en las últimas 24 horas`);
    return leads;
    
  } catch (error) {
    console.error('Error al obtener leads sin asignar:', error);
    return [];
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

// Funciones de branding consistentes
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

// Función para formatear fecha relativa
function getRelativeTime(date: string): string {
  const now = new Date();
  const leadDate = new Date(date);
  const diffInHours = Math.floor((now.getTime() - leadDate.getTime()) / (1000 * 60 * 60));
  
  if (diffInHours < 1) {
    return 'Just now';
  } else if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
  } else {
    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
  }
}

// Función para formatear el origin eliminando guiones bajos y mejorando formato
function formatOrigin(origin: string): string {
  if (!origin) return '';
  
  return origin
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Función para generar HTML del email para el equipo
function generateNewLeadsAlertHtml(data: {
  leads: any[];
  siteName: string;
  hoursUntilAutoProspect: number;
  totalUnassignedLeads: number;
  leadsUrl: string;
  assignLeadsUrl: string;
  logoUrl?: string;
  includeLeadDetails: boolean;
  locale?: string;
}): string {
  const autoProspectDate = new Date();
  autoProspectDate.setHours(autoProspectDate.getHours() + data.hoursUntilAutoProspect);
  
  const formatDate = (date: Date) => {
    return date.toLocaleDateString((data as any).locale === 'es' ? 'es-ES' : (data as any).locale === 'fr' ? 'fr-FR' : (data as any).locale === 'de' ? 'de-DE' : (data as any).locale === 'ja' ? 'ja-JP' : 'en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const priorityColors = {
    high: { bg: '#fff7ed', color: '#c2410c', badge: '#fed7aa' },
    urgent: { bg: '#fef2f2', color: '#dc2626', badge: '#fecaca' },
    normal: { bg: '#f8fafc', color: '#334155', badge: '#e2e8f0' },
    low: { bg: '#f0f9ff', color: '#0369a1', badge: '#e0f2fe' }
  };
  
  const priorityColor = data.hoursUntilAutoProspect <= 24 ? priorityColors.urgent :
                       data.hoursUntilAutoProspect <= 48 ? priorityColors.high : 
                       priorityColors.normal;
  
  return `
    <!DOCTYPE html>
    <html lang="${data.locale || 'en'}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Leads Alert - ${data.siteName}</title>
      <style>
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
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 700px; margin: 20px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="mobile-padding email-header" style="background: #1e1e2d; padding: 32px 20px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 80px; height: 80px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 20px; margin-bottom: 16px; width: 80px; height: 80px; box-sizing: border-box;">
            <div style="width: 40px; height: 40px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 20px;">🎯</div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Leads Alert</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">
            ${data.totalUnassignedLeads} unassigned lead${data.totalUnassignedLeads !== 1 ? 's' : ''} from the last 24 hours awaiting assignment
          </p>
        </div>
        
        <!-- Content -->
        <div class="mobile-padding" style="padding: 40px 20px;">
          
          <!-- Summary -->
          <div style="margin-bottom: 32px; text-align: center;">
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #111111; font-weight: 600;">
              Action Required: Assign Your Leads
            </h2>
            <p class="email-text" style="margin: 0; font-size: 16px; color: #111111; line-height: 1.7;">
              You have <strong>${data.totalUnassignedLeads} new lead${data.totalUnassignedLeads !== 1 ? 's' : ''} from the last 24 hours</strong> that need${data.totalUnassignedLeads === 1 ? 's' : ''} to be assigned to team members.
              ${data.hoursUntilAutoProspect > 0 ? `<span class="mobile-hide-break"><br></span><strong>In ${data.hoursUntilAutoProspect} hours</strong>, unassigned leads will automatically begin receiving personalized outreach from our sales team.` : ''}
            </p>
          </div>
          
          <!-- Automatic Outreach Warning -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div class="mobile-small-padding" style="display: inline-block; background-color: ${priorityColor.badge}; color: ${priorityColor.color}; padding: 12px 20px; border-radius: 20px; font-size: 14px; font-weight: 600; letter-spacing: 0.05em; max-width: 90%;">
              ⏰ Automatic outreach begins: ${formatDate(autoProspectDate)}
            </div>
          </div>
           
          <!-- Quick Stats -->
          <div style="margin-bottom: 32px;">
            <!-- Stats Container - Mobile Friendly -->
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="width: 50%; padding: 0 8px 16px 0; vertical-align: top;">
                  <div class="email-panel" style="background-color: #f0f0f5; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #e4e4e7;">
                    <div style="font-size: 28px; font-weight: 700; color: #3f6212; margin-bottom: 4px;">${data.totalUnassignedLeads.toString()}</div>
                    <div style="font-size: 14px; color: #3730a3; font-weight: 500;">Unassigned Leads</div>
                  </div>
                </td>
                <td style="width: 50%; padding: 0 0 16px 8px; vertical-align: top;">
                  <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #fbbf24;">
                    <div style="font-size: 28px; font-weight: 700; color: #000000; font-weight: 600; margin-bottom: 4px;">${data.hoursUntilAutoProspect.toString()}h</div>
                    <div style="font-size: 14px; color: #92400e; font-weight: 500;">Until Automatic Outreach</div>
                  </div>
                </td>
              </tr>
            </table>
          </div>
          
          ${data.includeLeadDetails && data.leads.length > 0 ? `
          <!-- Leads List -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 20px; font-size: 18px; color: #111111; font-weight: 600;">Unassigned Leads (Last 24 Hours)</h3>
            <div style="border: 1px solid #e4e4e7; border-radius: 8px; overflow: hidden;">
              ${data.leads.slice(0, 10).map((lead, index) => `
              <div class="mobile-small-padding" style="padding: 20px 16px; border-bottom: ${index < Math.min(data.leads.length, 10) - 1 ? '1px solid #e2e8f0' : 'none'}; ${index % 2 === 0 ? 'background-color: #f8fafc;' : 'background-color: #fafafa;'}">
                <!-- Mobile-friendly lead layout -->
                <div style="margin-bottom: 8px;">
                  <div class="email-text" style="font-weight: 600; color: #111111; font-size: 16px; margin-bottom: 8px;">
                    ${lead.name || 'Unknown Lead'}
                  </div>
                  
                  <!-- Contact Info -->
                  <div class="email-muted" style="color: #52525b; font-size: 14px; margin-bottom: 8px; line-height: 1.5;">
                    <div style="margin-bottom: 4px;">📧 ${lead.email || 'No email'}</div>
                    ${lead.phone ? `<div style="margin-bottom: 4px;">📞 ${lead.phone}</div>` : ''}
                    ${lead.company?.name ? `<div style="margin-bottom: 4px;">🏢 ${lead.company.name}</div>` : ''}
                  </div>
                  
                  <!-- Tags and Meta -->
                  <div style="margin-bottom: 8px;">
                    ${lead.segments?.name ? `
                    <span style="display: inline-block; background-color: #dbeafe; color: #3f6212; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; margin-right: 8px; margin-bottom: 4px;">
                      ${lead.segments.name}
                    </span>
                    ` : ''}
                    ${lead.origin ? `
                    <span style="display: inline-block; background-color: #f0fdf4; color: #16a34a; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; margin-bottom: 4px;">
                      via ${formatOrigin(lead.origin)}
                    </span>
                    ` : ''}
                  </div>
                  
                  <!-- Time -->
                  <div class="email-muted" style="color: #71717a; font-size: 12px;">
                    ${getRelativeTime(lead.created_at)}
                  </div>
                </div>
              </div>
              `).join('')}
              ${data.totalUnassignedLeads > 10 ? `
              <div class="email-muted" style="padding: 16px; background-color: #f0f0f5; text-align: center; color: #52525b; font-size: 14px;">
                And ${data.totalUnassignedLeads - 10} more lead${data.totalUnassignedLeads - 10 !== 1 ? 's' : ''} awaiting assignment...
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <!-- Primary Button -->
            <div style="margin-bottom: 16px;">
              <a href="${data.assignLeadsUrl}" 
                 class="mobile-button email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); min-width: 200px;">
                Assign Leads Now →
              </a>
            </div>
            <!-- Secondary Button -->
            <div>
              <a href="${data.leadsUrl}" 
                 class="mobile-button"
                 style="display: inline-block; background: #ffffff; color: #000000; border: 2px solid #000000; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; min-width: 200px;">
                View All Leads →
              </a>
            </div>
          </div>
          
          <!-- Automatic Outreach Explanation -->
          <div class="mobile-small-padding" style="margin-top: 32px; padding: 20px 16px; background-color: #fef9e7; border: 1px solid #fbbf24; border-radius: 8px;">
            <h4 style="margin: 0 0 12px; color: #92400e; font-size: 16px; font-weight: 600;">
              📧 About Automatic Outreach
            </h4>
            <p style="margin: 0; color: #451a03; font-size: 14px; line-height: 1.6;">
              Leads that remain unassigned will automatically begin receiving personalized follow-up messages from our sales team. 
              Our system will send targeted emails based on the lead's interests and your business messaging. 
              <strong>Assign leads to team members now to maintain personal control over the sales conversations.</strong>
            </p>
          </div>
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p class="mobile-text-sm" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
              This notification was automatically generated when new leads were detected.<span class="mobile-hide-break"><br></span>
              Manage your notification preferences in your account settings.
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div class="mobile-padding" style="background-color: #f8fafc; padding: 24px 20px; border-top: 1px solid #e2e8f0;">
          <p class="mobile-text-sm" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
            This notification was automatically generated by ${getCompanyName()}.<span class="mobile-hide-break"><br></span>
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
    console.log('🎯 [NewLeadsAlert] Iniciando notificación de leads nuevos sin asignar');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = NewLeadsAlertSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [NewLeadsAlert] Error de validación:', validationResult.error.errors);
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
      priority,
      hours_until_auto_prospect,
      include_lead_details,
      max_leads_to_display
    } = validationResult.data;
    
    console.log(`🔍 [NewLeadsAlert] Procesando alerta para sitio: ${site_id}`);
    
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
    
    // Obtener leads nuevos sin asignar
    const unassignedLeads = await getUnassignedNewLeads(site_id, max_leads_to_display);
    
    if (unassignedLeads.length === 0) {
      console.log('✅ [NewLeadsAlert] No hay leads sin asignar de las últimas 24 horas, no se enviará notificación');
      return NextResponse.json({
        success: true,
        data: {
          site_id,
          total_unassigned_leads: 0,
          message: 'No unassigned leads found in the last 24 hours',
          notification_sent: false
        }
      });
    }
    
    console.log(`📊 [NewLeadsAlert] Encontrados ${unassignedLeads.length} leads sin asignar`);
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const leadsUrl = `${baseUrl}/leads`;
    const assignLeadsUrl = `${baseUrl}/leads?action=assign`;
    
    // Enviar notificación al equipo
    console.log('📢 [NewLeadsAlert] Enviando notificación al equipo...');
    
    try {
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: site_id,
        title: `🎯 ${unassignedLeads.length} New Lead${unassignedLeads.length !== 1 ? 's' : ''} from Last 24h Awaiting Assignment`,
        message: `You have ${unassignedLeads.length} unassigned lead${unassignedLeads.length !== 1 ? 's' : ''} from the last 24 hours that will automatically begin receiving personalized outreach in ${hours_until_auto_prospect} hours if not assigned to team members.`,
        buildEmail: (locale) => ({
          subject: platformT(locale, 'new_leads_alert.subject', { count: unassignedLeads.length }),
          html: generateNewLeadsAlertHtml({
            leads: unassignedLeads,
            siteName: siteInfo.name || 'Your Site',
            hoursUntilAutoProspect: hours_until_auto_prospect,
            totalUnassignedLeads: unassignedLeads.length,
            leadsUrl,
            assignLeadsUrl,
            logoUrl: siteInfo.logo_url,
            includeLeadDetails: include_lead_details,
            locale
          })
        }),
        priority: priority as any,
        type: NotificationType.WARNING,
        categories: ['new-leads-alert', 'lead-assignment', 'automatic-outreach-warning'],
        customArgs: {
          siteId: site_id,
          totalUnassignedLeads: unassignedLeads.length.toString(),
          hoursUntilAutoProspect: hours_until_auto_prospect.toString(),
          alertType: 'new_leads_assignment_required'
        },
        relatedEntityType: 'site',
        relatedEntityId: site_id
      });
      
      if (teamNotificationResult.success) {
        console.log(`✅ [NewLeadsAlert] Equipo notificado exitosamente: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
        
        return NextResponse.json({
          success: true,
          data: {
            site_id,
            total_unassigned_leads: unassignedLeads.length,
            hours_until_auto_prospect,
            site_info: {
              name: siteInfo.name
            },
            notification_sent: true,
            notifications_sent: teamNotificationResult.notificationsSent,
            emails_sent: teamNotificationResult.emailsSent,
            team_members_notified: teamNotificationResult.notificationsSent,
            leads_preview: include_lead_details ? unassignedLeads.slice(0, 5).map(lead => ({
              id: lead.id,
              name: lead.name,
              email: lead.email,
              created_at: lead.created_at,
              origin: lead.origin,
              segment: lead.segments?.name
            })) : undefined,
            sent_at: new Date().toISOString()
          }
        });
      } else {
        console.error(`❌ [NewLeadsAlert] Error enviando notificación: ${teamNotificationResult.errors?.join(', ')}`);
        
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'NOTIFICATION_SEND_ERROR',
              message: `Failed to send notification: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`
            }
          },
          { status: 500 }
        );
      }
    } catch (error) {
      console.error(`❌ [NewLeadsAlert] Error enviando notificación:`, error);
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NOTIFICATION_ERROR',
            message: `Error sending notification: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        },
        { status: 500 }
      );
    }
    
  } catch (error) {
    console.error('❌ [NewLeadsAlert] Error general:', error);
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