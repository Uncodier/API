import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const NewCampaignsSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  include_campaign_details: z.boolean().default(true),
  max_campaigns_to_display: z.number().min(1).max(50).default(20),
  campaign_status: z.enum(['pending', 'approved', 'in_progress']).default('pending'),
  days_since_created: z.number().min(0).max(365).default(7) // Campañas creadas en los últimos N días
});

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener campañas nuevas
async function getNewCampaigns(siteId: string, status: string = 'pending', daysSince: number = 7, maxCampaigns: number = 20): Promise<any[]> {
  try {
    console.log(`🔍 [NewCampaigns] Buscando campañas nuevas para sitio: ${siteId}, estado: ${status}`);
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysSince);
    
    const { data: campaigns, error } = await supabaseAdmin
      .from('campaigns')
      .select(`
        id,
        title,
        description,
        type,
        status,
        priority,
        due_date,
        budget,
        revenue,
        created_at,
        updated_at,
        assignees,
        issues
      `)
      .eq('site_id', siteId)
      .eq('status', status)
      .gte('created_at', cutoffDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(maxCampaigns);
    
    if (error) {
      console.error('Error al obtener campañas nuevas:', error);
      return [];
    }
    
    if (!campaigns || campaigns.length === 0) {
      console.log('⚠️ No se encontraron campañas nuevas');
      return [];
    }
    
    console.log(`✅ Encontradas ${campaigns.length} campañas nuevas`);
    return campaigns;
    
  } catch (error) {
    console.error('Error al obtener campañas nuevas:', error);
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
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Función para formatear fecha relativa
function getRelativeTime(date: string): string {
  const now = new Date();
  const campaignDate = new Date(date);
  const diffInHours = Math.floor((now.getTime() - campaignDate.getTime()) / (1000 * 60 * 60));
  
  if (diffInHours < 1) {
    return 'Just now';
  } else if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
  } else {
    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
  }
}

// Función para formatear tipo de campaña
function formatCampaignType(type: string): string {
  const typeMap: Record<string, string> = {
    search_ads: 'Search Ads',
    social_ads: 'Social Media Ads',
    display_ads: 'Display Ads',
    email_marketing: 'Email Marketing',
    content_creation: 'Content Marketing',
    video_marketing: 'Video Marketing',
    affiliate: 'Affiliate Marketing',
    retargeting: 'Retargeting',
    inbound: 'Inbound Marketing',
    outbound: 'Outbound Marketing',
    branding: 'Brand Awareness',
    product: 'Product Marketing',
    events: 'Event Marketing',
    guerrilla: 'Guerrilla Marketing',
    influencer: 'Influencer Marketing'
  };
  return typeMap[type] || type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ');
}

// Función para formatear presupuesto
function formatBudget(budget: any): string {
  if (!budget || typeof budget !== 'object') return 'N/A';
  
  const currency = budget.currency || 'USD';
  const allocated = budget.allocated || 0;
  
  if (allocated === 0) return 'TBD';
  
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(allocated);
}

// Función para generar HTML del email para el equipo
function generateNewCampaignsAlertHtml(data: {
  campaigns: any[];
  siteName: string;
  totalNewCampaigns: number;
  campaignsUrl: string;
  reviewUrl: string;
  logoUrl?: string;
  includeCampaignDetails: boolean;
  campaignStatus: string;
  daysSince: number;
}): string {
  const statusColors = {
    pending: { bg: '#fef3c7', color: '#92400e', badge: '#fed7aa' },
    approved: { bg: '#d1fae5', color: '#065f46', badge: '#a7f3d0' },
    in_progress: { bg: '#dbeafe', color: '#1e40af', badge: '#bfdbfe' }
  };
  
  const statusColor = statusColors[data.campaignStatus as keyof typeof statusColors] || statusColors.pending;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Campaigns Alert - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 700px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 24px;">🚀</div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Campaigns Alert</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">
            ${data.totalNewCampaigns} new campaign${data.totalNewCampaigns !== 1 ? 's' : ''} ready for review
          </p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Summary -->
          <div style="margin-bottom: 32px; text-align: center;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              New Campaigns Ready for Review
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              You have <strong>${data.totalNewCampaigns} campaign${data.totalNewCampaigns !== 1 ? 's' : ''}</strong> 
              in <strong>${data.campaignStatus}</strong> status created in the last ${data.daysSince} day${data.daysSince !== 1 ? 's' : ''}.
              <br>These campaigns are ready for your review and approval to begin execution.
            </p>
          </div>
          
          <!-- Status Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${statusColor.badge}; color: ${statusColor.color}; padding: 12px 24px; border-radius: 20px; font-size: 14px; font-weight: 600; letter-spacing: 0.05em;">
              🚀 Status: ${data.campaignStatus.charAt(0).toUpperCase() + data.campaignStatus.slice(1).replace('_', ' ')}
            </div>
          </div>
           
          <!-- Quick Stats -->
          <div style="margin-bottom: 32px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #d1d5db;">
              <div style="font-size: 28px; font-weight: 700; color: #7c3aed; margin-bottom: 4px;">${data.totalNewCampaigns.toString()}</div>
              <div style="font-size: 14px; color: #4b5563; font-weight: 500;">New Campaigns</div>
            </div>
            <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #fbbf24;">
              <div style="font-size: 28px; font-weight: 700; color: #d97706; margin-bottom: 4px;">${data.daysSince.toString()}</div>
              <div style="font-size: 14px; color: #92400e; font-weight: 500;">Days Range</div>
            </div>
          </div>
          
          ${data.includeCampaignDetails && data.campaigns.length > 0 ? `
          <!-- Campaigns List -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 20px; font-size: 18px; color: #1e293b; font-weight: 600;">Recent Campaigns</h3>
            <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
              ${data.campaigns.slice(0, 10).map((campaign, index) => `
              <div style="padding: 20px; border-bottom: ${index < Math.min(data.campaigns.length, 10) - 1 ? '1px solid #e2e8f0' : 'none'}; ${index % 2 === 0 ? 'background-color: #f8fafc;' : 'background-color: #ffffff;'}">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                  <div>
                    <div style="font-weight: 600; color: #1e293b; font-size: 16px; margin-bottom: 4px;">
                      ${campaign.title || 'Untitled Campaign'}
                    </div>
                    <div style="color: #64748b; font-size: 14px; margin-bottom: 4px;">
                      🎯 ${formatCampaignType(campaign.type)}
                      ${campaign.budget ? ` • Budget: ${formatBudget(campaign.budget)}` : ''}
                      ${campaign.priority ? ` • Priority: ${campaign.priority}` : ''}
                    </div>
                    ${campaign.description ? `
                    <div style="color: #64748b; font-size: 14px; margin-bottom: 8px; max-width: 400px;">
                      ${campaign.description.length > 100 ? campaign.description.substring(0, 100) + '...' : campaign.description}
                    </div>
                    ` : ''}
                    ${campaign.due_date ? `
                    <div style="color: #64748b; font-size: 14px; margin-bottom: 8px;">
                      📅 Due: ${new Date(campaign.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    ` : ''}
                    <div style="display: inline-block; background-color: ${statusColor.bg}; color: ${statusColor.color}; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 500;">
                      ${data.campaignStatus}
                    </div>
                  </div>
                  <div style="text-align: right; color: #64748b; font-size: 12px;">
                    <div style="margin-bottom: 4px;">${getRelativeTime(campaign.created_at)}</div>
                    ${campaign.revenue?.estimated ? `
                    <div style="color: #16a34a; font-weight: 500; font-size: 11px;">
                      Est. ${formatBudget(campaign.revenue)}
                    </div>
                    ` : ''}
                  </div>
                </div>
              </div>
              `).join('')}
              ${data.totalNewCampaigns > 10 ? `
              <div style="padding: 16px; background-color: #f1f5f9; text-align: center; color: #64748b; font-size: 14px;">
                And ${data.totalNewCampaigns - 10} more campaign${data.totalNewCampaigns - 10 !== 1 ? 's' : ''} awaiting review...
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.reviewUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); margin: 0 8px 12px; vertical-align: top;">
              Review Campaigns →
            </a>
            <a href="${data.campaignsUrl}" 
               style="display: inline-block; background: #ffffff; color: #8b5cf6; border: 2px solid #8b5cf6; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; margin: 0 8px 12px; vertical-align: top;">
              View All Campaigns →
            </a>
          </div>
          
          <!-- Campaign Workflow Explanation -->
          <div style="margin-top: 32px; padding: 20px 24px; background-color: #faf5ff; border: 1px solid #c084fc; border-radius: 8px;">
            <h4 style="margin: 0 0 12px; color: #581c87; font-size: 16px; font-weight: 600;">
              🚀 About Campaign Proposals
            </h4>
            <p style="margin: 0; color: #581c87; font-size: 14px; line-height: 1.6;">
              New campaigns are automatically proposed by your AI growth team based on market analysis and business objectives. 
              Review and approve campaigns to allocate budget and resources for execution.
            </p>
          </div>
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              This notification was automatically generated when new campaigns were proposed.<br>
              Manage your notification preferences in your account settings.
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
          Powered by <strong style="color: #8b5cf6;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('🚀 [NewCampaigns] Iniciando notificación de campañas nuevas');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = NewCampaignsSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [NewCampaigns] Error de validación:', validationResult.error.errors);
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
      include_campaign_details,
      max_campaigns_to_display,
      campaign_status,
      days_since_created
    } = validationResult.data;
    
    console.log(`🔍 [NewCampaigns] Procesando alerta para sitio: ${site_id}`);
    
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
    
    // Obtener campañas nuevas
    const newCampaigns = await getNewCampaigns(site_id, campaign_status, days_since_created, max_campaigns_to_display);
    
    if (newCampaigns.length === 0) {
      console.log('✅ [NewCampaigns] No hay campañas nuevas, no se enviará notificación');
      return NextResponse.json({
        success: true,
        data: {
          site_id,
          total_new_campaigns: 0,
          message: 'No new campaigns found',
          notification_sent: false
        }
      });
    }
    
    console.log(`📊 [NewCampaigns] Encontradas ${newCampaigns.length} campañas nuevas`);
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const campaignsUrl = `${baseUrl}/sites/${site_id}/campaigns`;
    const reviewUrl = `${baseUrl}/sites/${site_id}/campaigns?status=${campaign_status}`;
    
    // Enviar notificación al equipo
    console.log('📢 [NewCampaigns] Enviando notificación al equipo...');
    
    try {
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: site_id,
        title: `🚀 ${newCampaigns.length} New Campaign${newCampaigns.length !== 1 ? 's' : ''} Ready for Review`,
        message: `You have ${newCampaigns.length} new campaign${newCampaigns.length !== 1 ? 's' : ''} in ${campaign_status} status ready for review and approval.`,
        htmlContent: generateNewCampaignsAlertHtml({
          campaigns: newCampaigns,
          siteName: siteInfo.name || 'Your Site',
          totalNewCampaigns: newCampaigns.length,
          campaignsUrl,
          reviewUrl,
          logoUrl: siteInfo.logo_url,
          includeCampaignDetails: include_campaign_details,
          campaignStatus: campaign_status,
          daysSince: days_since_created
        }),
        priority: priority as any,
        type: NotificationType.INFO,
        categories: ['new-campaigns-alert', 'campaign-review', 'campaign-workflow'],
        customArgs: {
          siteId: site_id,
          totalNewCampaigns: newCampaigns.length.toString(),
          campaignStatus: campaign_status,
          daysSinceCreated: days_since_created.toString(),
          alertType: 'new_campaigns_review_required'
        },
        relatedEntityType: 'site',
        relatedEntityId: site_id
      });
      
      if (teamNotificationResult.success) {
        console.log(`✅ [NewCampaigns] Equipo notificado exitosamente: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
        
        return NextResponse.json({
          success: true,
          data: {
            site_id,
            total_new_campaigns: newCampaigns.length,
            campaign_status,
            days_since_created,
            site_info: {
              name: siteInfo.name
            },
            notification_sent: true,
            notifications_sent: teamNotificationResult.notificationsSent,
            emails_sent: teamNotificationResult.emailsSent,
            team_members_notified: teamNotificationResult.notificationsSent,
            campaigns_preview: include_campaign_details ? newCampaigns.slice(0, 5).map(campaign => ({
              id: campaign.id,
              title: campaign.title,
              type: campaign.type,
              status: campaign.status,
              priority: campaign.priority,
              created_at: campaign.created_at,
              budget: campaign.budget,
              due_date: campaign.due_date
            })) : undefined,
            sent_at: new Date().toISOString()
          }
        });
      } else {
        console.error(`❌ [NewCampaigns] Error enviando notificación: ${teamNotificationResult.errors?.join(', ')}`);
        
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
      console.error(`❌ [NewCampaigns] Error enviando notificación:`, error);
      
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
    console.error('❌ [NewCampaigns] Error general:', error);
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