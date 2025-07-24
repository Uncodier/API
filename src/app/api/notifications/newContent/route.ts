import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const NewContentSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  include_content_details: z.boolean().default(true),
  max_content_to_display: z.number().min(1).max(50).default(20),
  content_status: z.enum(['draft', 'review', 'approved']).default('draft'),
  days_since_created: z.number().min(0).max(365).default(7) // Contenido creado en los últimos N días
});

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener contenidos nuevos
async function getNewContent(siteId: string, status: string = 'draft', daysSince: number = 7, maxContent: number = 20): Promise<any[]> {
  try {
    console.log(`🔍 [NewContent] Buscando contenido nuevo para sitio: ${siteId}, estado: ${status}`);
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysSince);
    
    const { data: content, error } = await supabaseAdmin
      .from('content')
      .select(`
        id,
        title,
        description,
        type,
        status,
        created_at,
        updated_at,
        author_id,
        segment_id,
        campaign_id,
        word_count,
        estimated_reading_time
      `)
      .eq('site_id', siteId)
      .eq('status', status)
      .gte('created_at', cutoffDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(maxContent);
    
    if (error) {
      console.error('Error al obtener contenido nuevo:', error);
      return [];
    }
    
    if (!content || content.length === 0) {
      console.log('⚠️ No se encontró contenido nuevo');
      return [];
    }
    
    console.log(`✅ Encontrados ${content.length} contenidos nuevos`);
    return content;
    
  } catch (error) {
    console.error('Error al obtener contenido nuevo:', error);
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
  const contentDate = new Date(date);
  const diffInHours = Math.floor((now.getTime() - contentDate.getTime()) / (1000 * 60 * 60));
  
  if (diffInHours < 1) {
    return 'Just now';
  } else if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
  } else {
    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
  }
}

// Función para formatear tipo de contenido
function formatContentType(type: string): string {
  const typeMap: Record<string, string> = {
    blog_post: 'Blog Post',
    video: 'Video',
    podcast: 'Podcast',
    social_post: 'Social Post',
    newsletter: 'Newsletter',
    case_study: 'Case Study',
    whitepaper: 'Whitepaper',
    infographic: 'Infographic',
    webinar: 'Webinar',
    ebook: 'E-book',
    ad: 'Advertisement',
    landing_page: 'Landing Page'
  };
  return typeMap[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

// Función para generar HTML del email para el equipo
function generateNewContentAlertHtml(data: {
  content: any[];
  siteName: string;
  totalNewContent: number;
  contentUrl: string;
  reviewUrl: string;
  logoUrl?: string;
  includeContentDetails: boolean;
  contentStatus: string;
  daysSince: number;
}): string {
  const statusColors = {
    draft: { bg: '#fef3c7', color: '#92400e', badge: '#fed7aa' },
    review: { bg: '#dbeafe', color: '#1e40af', badge: '#bfdbfe' },
    approved: { bg: '#d1fae5', color: '#065f46', badge: '#a7f3d0' }
  };
  
  const statusColor = statusColors[data.contentStatus as keyof typeof statusColors] || statusColors.draft;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Content Alert - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 700px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 24px;">📝</div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Content Alert</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">
            ${data.totalNewContent} new content piece${data.totalNewContent !== 1 ? 's' : ''} ready for review
          </p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Summary -->
          <div style="margin-bottom: 32px; text-align: center;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              New Content Ready for Review
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              You have <strong>${data.totalNewContent} content piece${data.totalNewContent !== 1 ? 's' : ''}</strong> 
              in <strong>${data.contentStatus}</strong> status created in the last ${data.daysSince} day${data.daysSince !== 1 ? 's' : ''}.
              <br>These content pieces are ready for your review and approval.
            </p>
          </div>
          
          <!-- Status Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${statusColor.badge}; color: ${statusColor.color}; padding: 12px 24px; border-radius: 20px; font-size: 14px; font-weight: 600; letter-spacing: 0.05em;">
              📋 Status: ${data.contentStatus.charAt(0).toUpperCase() + data.contentStatus.slice(1)}
            </div>
          </div>
           
          <!-- Quick Stats -->
          <div style="margin-bottom: 32px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
            <div style="background-color: #ecfdf5; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #a7f3d0;">
              <div style="font-size: 28px; font-weight: 700; color: #059669; margin-bottom: 4px;">${data.totalNewContent.toString()}</div>
              <div style="font-size: 14px; color: #065f46; font-weight: 500;">New Content</div>
            </div>
            <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #fbbf24;">
              <div style="font-size: 28px; font-weight: 700; color: #d97706; margin-bottom: 4px;">${data.daysSince.toString()}</div>
              <div style="font-size: 14px; color: #92400e; font-weight: 500;">Days Range</div>
            </div>
          </div>
          
          ${data.includeContentDetails && data.content.length > 0 ? `
          <!-- Content List -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 20px; font-size: 18px; color: #1e293b; font-weight: 600;">Recent Content</h3>
            <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
              ${data.content.slice(0, 10).map((content, index) => `
              <div style="padding: 20px; border-bottom: ${index < Math.min(data.content.length, 10) - 1 ? '1px solid #e2e8f0' : 'none'}; ${index % 2 === 0 ? 'background-color: #f8fafc;' : 'background-color: #ffffff;'}">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                  <div>
                    <div style="font-weight: 600; color: #1e293b; font-size: 16px; margin-bottom: 4px;">
                      ${content.title || 'Untitled Content'}
                    </div>
                    <div style="color: #64748b; font-size: 14px; margin-bottom: 4px;">
                      📄 ${formatContentType(content.type)}
                      ${content.word_count ? ` • ${content.word_count} words` : ''}
                      ${content.estimated_reading_time ? ` • ${content.estimated_reading_time} min read` : ''}
                    </div>
                    ${content.description ? `
                    <div style="color: #64748b; font-size: 14px; margin-bottom: 8px; max-width: 400px;">
                      ${content.description.length > 100 ? content.description.substring(0, 100) + '...' : content.description}
                    </div>
                    ` : ''}
                    <div style="display: inline-block; background-color: ${statusColor.bg}; color: ${statusColor.color}; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 500;">
                      ${data.contentStatus}
                    </div>
                  </div>
                  <div style="text-align: right; color: #64748b; font-size: 12px;">
                    <div style="margin-bottom: 4px;">${getRelativeTime(content.created_at)}</div>
                  </div>
                </div>
              </div>
              `).join('')}
              ${data.totalNewContent > 10 ? `
              <div style="padding: 16px; background-color: #f1f5f9; text-align: center; color: #64748b; font-size: 14px;">
                And ${data.totalNewContent - 10} more content piece${data.totalNewContent - 10 !== 1 ? 's' : ''} awaiting review...
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Action Buttons -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.reviewUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); margin: 0 8px 12px; vertical-align: top;">
              Review Content →
            </a>
            <a href="${data.contentUrl}" 
               style="display: inline-block; background: #ffffff; color: #10b981; border: 2px solid #10b981; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; margin: 0 8px 12px; vertical-align: top;">
              View All Content →
            </a>
          </div>
          
          <!-- Content Workflow Explanation -->
          <div style="margin-top: 32px; padding: 20px 24px; background-color: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 8px;">
            <h4 style="margin: 0 0 12px; color: #0c4a6e; font-size: 16px; font-weight: 600;">
              📝 About Content Review
            </h4>
            <p style="margin: 0; color: #0c4a6e; font-size: 14px; line-height: 1.6;">
              New content is automatically created by your AI agents based on your marketing strategy and requirements. 
              Review and approve content to ensure it aligns with your brand voice and messaging before publication.
            </p>
          </div>
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              This notification was automatically generated when new content was detected.<br>
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
          Powered by <strong style="color: #10b981;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('📝 [NewContent] Iniciando notificación de contenido nuevo');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = NewContentSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [NewContent] Error de validación:', validationResult.error.errors);
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
      include_content_details,
      max_content_to_display,
      content_status,
      days_since_created
    } = validationResult.data;
    
    console.log(`🔍 [NewContent] Procesando alerta para sitio: ${site_id}`);
    
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
    
    // Obtener contenido nuevo
    const newContent = await getNewContent(site_id, content_status, days_since_created, max_content_to_display);
    
    if (newContent.length === 0) {
      console.log('✅ [NewContent] No hay contenido nuevo, no se enviará notificación');
      return NextResponse.json({
        success: true,
        data: {
          site_id,
          total_new_content: 0,
          message: 'No new content found',
          notification_sent: false
        }
      });
    }
    
    console.log(`📊 [NewContent] Encontrados ${newContent.length} contenidos nuevos`);
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const contentUrl = `${baseUrl}/content`;
    const reviewUrl = `${baseUrl}/content?status=${content_status}`;
    
    // Enviar notificación al equipo
    console.log('📢 [NewContent] Enviando notificación al equipo...');
    
    try {
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: site_id,
        title: `📝 ${newContent.length} New Content Piece${newContent.length !== 1 ? 's' : ''} Ready for Review`,
        message: `You have ${newContent.length} new content piece${newContent.length !== 1 ? 's' : ''} in ${content_status} status ready for review and approval.`,
        htmlContent: generateNewContentAlertHtml({
          content: newContent,
          siteName: siteInfo.name || 'Your Site',
          totalNewContent: newContent.length,
          contentUrl,
          reviewUrl,
          logoUrl: siteInfo.logo_url,
          includeContentDetails: include_content_details,
          contentStatus: content_status,
          daysSince: days_since_created
        }),
        priority: priority as any,
        type: NotificationType.INFO,
        categories: ['new-content-alert', 'content-review', 'content-workflow'],
        customArgs: {
          siteId: site_id,
          totalNewContent: newContent.length.toString(),
          contentStatus: content_status,
          daysSinceCreated: days_since_created.toString(),
          alertType: 'new_content_review_required'
        },
        relatedEntityType: 'site',
        relatedEntityId: site_id
      });
      
      if (teamNotificationResult.success) {
        console.log(`✅ [NewContent] Equipo notificado exitosamente: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
        
        return NextResponse.json({
          success: true,
          data: {
            site_id,
            total_new_content: newContent.length,
            content_status,
            days_since_created,
            site_info: {
              name: siteInfo.name
            },
            notification_sent: true,
            notifications_sent: teamNotificationResult.notificationsSent,
            emails_sent: teamNotificationResult.emailsSent,
            team_members_notified: teamNotificationResult.notificationsSent,
            content_preview: include_content_details ? newContent.slice(0, 5).map(content => ({
              id: content.id,
              title: content.title,
              type: content.type,
              status: content.status,
              created_at: content.created_at,
              word_count: content.word_count
            })) : undefined,
            sent_at: new Date().toISOString()
          }
        });
      } else {
        console.error(`❌ [NewContent] Error enviando notificación: ${teamNotificationResult.errors?.join(', ')}`);
        
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
      console.error(`❌ [NewContent] Error enviando notificación:`, error);
      
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
    console.error('❌ [NewContent] Error general:', error);
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