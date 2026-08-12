import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema para un insight individual
const InsightSchema = z.object({
  type: z.enum(['finding', 'change', 'recommendation', 'alert']),
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
  impact: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  category: z.string().optional(),
  affected_area: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

// Schema de validación para la request
const ProjectAnalysisSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  insights: z.array(InsightSchema).min(1, 'Al menos un insight es requerido'),
  analysis_type: z.string().optional().default('profile_update'),
  analysis_summary: z.string().optional(),
  impact_level: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium')
});

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

// Función para generar HTML del email para el equipo
function generateTeamAnalysisNotificationHtml(data: {
  siteName: string;
  analysisSummary: string;
  analysisType: string;
  impactLevel: string;
  siteUrl?: string;
  logoUrl?: string;
  insights: Array<{
    type: 'finding' | 'change' | 'recommendation' | 'alert';
    title: string;
    description: string;
    impact?: 'low' | 'medium' | 'high' | 'critical';
    category?: string;
    affected_area?: string;
    metadata?: Record<string, any>;
  }>;
  locale?: string;
}): string {
  const impactBadgeColor = {
    low: { bg: '#d1fae5', color: '#065f46' },
    medium: { bg: '#fef3c7', color: '#92400e' },
    high: { bg: '#fee2e2', color: '#991b1b' },
    critical: { bg: '#fecaca', color: '#7f1d1d' }
  };
  
  const impactColor = impactBadgeColor[data.impactLevel as keyof typeof impactBadgeColor];
  
  // Agrupar insights por tipo
  const insightsByType = data.insights.reduce((acc, insight) => {
    if (!acc[insight.type]) acc[insight.type] = [];
    acc[insight.type].push(insight);
    return acc;
  }, {} as Record<string, typeof data.insights>);
  
  // Obtener áreas afectadas únicas
  const affectedAreas = Array.from(new Set(data.insights
    .filter(insight => insight.affected_area)
    .map(insight => insight.affected_area!)
  ));
  
  // Función para renderizar un insight
  const renderInsight = (insight: typeof data.insights[0]) => `
    <div class="email-panel" style="background-color: #f0f0f5; padding: 16px; border-radius: 6px; border: 1px solid #e4e4e7; margin-bottom: 12px;">
      <div style="display: flex; align-items: center; margin-bottom: 8px;">
        <h4 class="email-heading" style="margin: 0; color: #111111; font-size: 14px; font-weight: 600; flex: 1;">${insight.title}</h4>
        ${insight.impact ? `
          <span class="email-badge" style="background-color: ${impactBadgeColor[insight.impact].bg}; color: ${impactBadgeColor[insight.impact].color}; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; text-transform: uppercase;">
            ${insight.impact}
          </span>
        ` : ''}
      </div>
      <p class="email-muted" style="margin: 0; color: #52525b; font-size: 13px; line-height: 1.5;">${insight.description}</p>
      ${insight.category ? `
        <div style="margin-top: 8px;">
          <span class="email-text" style="background-color: #f0f0f5; color: #111111; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;">
            ${insight.category}
          </span>
        </div>
      ` : ''}
    </div>
  `;
  
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
      <title>Site Analysis Complete - ${data.siteName}</title>
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
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">🔍 Site Analysis Complete</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">AI agents have analyzed your site and updated your profile</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Impact Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div class="email-badge" style="display: inline-block; background-color: ${impactColor.bg}; color: ${impactColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.impactLevel} Impact
            </div>
          </div>
          
          <!-- Alert Banner -->
          <div style="background: #1e1e2d; padding: 20px 24px; border-radius: 8px; margin-bottom: 32px; border-left: 4px solid #90ff17;">
            <h3 style="margin: 0 0 8px; color: #92400e; font-size: 16px; font-weight: 600;">⚠️ Review Required</h3>
            <p style="margin: 0; color: #78350f; font-size: 14px; line-height: 1.6;">
              This analysis may affect your prospecting efforts. Please review the changes and validate the updated profile.
            </p>
          </div>
          
          <!-- Site Information -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Site Information</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 100px;">Site:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${data.siteName}</span>
              </div>
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 100px;">Analysis Type:</span>
                <span class="email-text" style="color: #111111; font-size: 15px; text-transform: capitalize;">${data.analysisType.replace('_', ' ')}</span>
              </div>
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 100px;">Total Insights:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${data.insights.length}</span>
              </div>
            </div>
          </div>
          
          <!-- Analysis Summary -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Analysis Summary</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">
                ${data.analysisSummary}
              </div>
            </div>
          </div>
          
          <!-- Key Findings -->
          ${insightsByType.finding && insightsByType.finding.length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">🔍 Key Findings</h3>
            <div style="background-color: #ecfdf5; padding: 20px 24px; border-radius: 8px; border: 1px solid #000000;">
              ${insightsByType.finding.map(insight => renderInsight(insight)).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Changes Made -->
          ${insightsByType.change && insightsByType.change.length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">🔄 Changes Made</h3>
            <div style="background-color: #fef3c7; padding: 20px 24px; border-radius: 8px; border: 1px solid #000000;">
              ${insightsByType.change.map(insight => renderInsight(insight)).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Recommendations -->
          ${insightsByType.recommendation && insightsByType.recommendation.length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">💡 Recommendations</h3>
            <div style="background-color: #f0f9ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #0ea5e9;">
              ${insightsByType.recommendation.map(insight => renderInsight(insight)).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Alerts -->
          ${insightsByType.alert && insightsByType.alert.length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">⚠️ Alerts</h3>
            <div style="background-color: #fef2f2; padding: 20px 24px; border-radius: 8px; border: 1px solid #ef4444;">
              ${insightsByType.alert.map(insight => renderInsight(insight)).join('')}
            </div>
          </div>
          ` : ''}
          
          <!-- Affected Areas -->
          ${affectedAreas.length > 0 ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">📊 Affected Areas</h3>
            <div style="background-color: #fef3c7; padding: 20px 24px; border-radius: 8px; border: 1px solid #000000;">
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${affectedAreas.map(area => `
                  <span style="background-color: #f0f0f5; color: #92400e; padding: 4px 12px; border-radius: 16px; font-size: 13px; font-weight: 500; text-transform: capitalize;">
                    ${area.replace('_', ' ')}
                  </span>
                `).join('')}
              </div>
            </div>
          </div>
          ` : ''}
          
          <!-- Action Button -->
          ${data.siteUrl ? `
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.siteUrl}" 
               class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s;">
              Review Site Profile →
            </a>
          </div>
          ` : ''}
          
          <!-- Important Note -->
          <div style="background: #1e1e2d; padding: 20px 24px; border-radius: 8px; margin-top: 32px; border-left: 4px solid #ef4444;">
            <h4 style="margin: 0 0 8px; color: #991b1b; font-size: 14px; font-weight: 600;">⚠️ Important Notice</h4>
            <p style="margin: 0; color: #7f1d1d; font-size: 13px; line-height: 1.5;">
              Changes to your site profile may impact lead scoring, segmentation, and targeting. Please review these updates promptly to ensure optimal prospecting performance.
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
            This analysis was automatically generated by ${getCompanyName()} AI agents.<br>
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
    console.log('🔍 [ProjectAnalysis] Iniciando notificación de análisis de proyecto');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = ProjectAnalysisSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [ProjectAnalysis] Error de validación:', validationResult.error.errors);
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
    
    const { site_id } = validationResult.data;
    
    console.log(`🔍 [ProjectAnalysis] Procesando notificación de análisis para sitio: ${site_id}`);
    
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
    
    const results = {
      success: true,
      notifications_sent: 0,
      emails_sent: 0,
      errors: [] as string[]
    };
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const siteUrl = `${baseUrl}/dashboard`;
    
    // Usar los insights proporcionados o valores por defecto
    const insights = validationResult.data.insights.length > 0 ? validationResult.data.insights : [
      {
        type: 'finding' as const,
        title: 'Updated company industry classification',
        description: 'The AI agent identified and updated the company\'s industry classification based on the latest market trends and customer data.',
        impact: 'medium' as const,
        affected_area: 'lead_scoring'
      },
      {
        type: 'change' as const,
        title: 'Refined target audience segments',
        description: 'The AI agent redefined the target audience segments to better align with the company\'s current market position and customer needs.',
        impact: 'medium' as const,
        affected_area: 'segmentation'
      },
      {
        type: 'recommendation' as const,
        title: 'Review updated ICP profiles',
        description: 'Please review and validate the updated Ideal Customer Profile segments to ensure they align with your prospecting goals.',
        impact: 'medium' as const,
        affected_area: 'targeting'
      }
    ];
    
    // Datos para la notificación
    const analysisData = {
      siteName: siteInfo.name || 'Unknown Site',
      analysisSummary: validationResult.data.analysis_summary || 'AI agents have analyzed your site and updated key profile information that may affect prospecting.',
      analysisType: validationResult.data.analysis_type,
      impactLevel: validationResult.data.impact_level,
      siteUrl,
      logoUrl: siteInfo.logo_url,
      insights: insights
    };
    
    // Enviar notificación al equipo usando TeamNotificationService
    console.log('📢 [ProjectAnalysis] Enviando notificación al equipo...');
    
    try {
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: site_id,
        title: `Site Analysis Complete: ${siteInfo.name}`,
        message: `AI agents have analyzed your site and updated key profile information that may affect prospecting.`,
        buildEmail: (locale) => ({
          subject: platformT(locale, 'project_analysis.subject', { title: siteInfo.name || 'Site' }),
          html: generateTeamAnalysisNotificationHtml({ ...analysisData, locale })
        }),
        priority: 'normal',
        type: NotificationType.INFO,
        categories: ['analysis-notification', 'site-analysis', 'profile-update'],
        customArgs: {
          siteId: site_id,
          analysisType: 'profile_update',
          generatedAt: new Date().toISOString()
        },
        relatedEntityType: 'site',
        relatedEntityId: site_id
      });
      
      if (teamNotificationResult.success) {
        results.notifications_sent = teamNotificationResult.notificationsSent;
        results.emails_sent = teamNotificationResult.emailsSent;
        console.log(`✅ [ProjectAnalysis] Equipo notificado: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
      } else {
        const errorMsg = `Failed to notify team: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`;
        results.errors.push(errorMsg);
        console.error(`❌ [ProjectAnalysis] ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = `Error notifying team: ${error instanceof Error ? error.message : 'Unknown error'}`;
      results.errors.push(errorMsg);
      console.error(`❌ [ProjectAnalysis] ${errorMsg}`, error);
    }
    
    // Determinar el éxito general
    results.success = results.notifications_sent > 0 && results.errors.length === 0;
    
    console.log(`📊 [ProjectAnalysis] Resumen de notificaciones:`, {
              success: results.success,
        notifications_sent: results.notifications_sent,
        emails_sent: results.emails_sent,
        errors: results.errors.length
    });
    
    return NextResponse.json({
      success: results.success,
      data: {
        site_id,
        site_info: {
          name: siteInfo.name
        },
        emails_sent: results.emails_sent,
        notifications_sent: results.notifications_sent,
        analysis_summary: analysisData.analysisSummary,
        key_findings_count: analysisData.insights.filter(insight => insight.type === 'finding').length,
        affected_areas_count: Array.from(new Set(analysisData.insights
          .filter(insight => insight.affected_area)
          .map(insight => insight.affected_area!)
        )).length,
        recommendations_count: analysisData.insights.filter(insight => insight.type === 'recommendation').length,
        errors: results.errors.length > 0 ? results.errors : undefined,
        sent_at: new Date().toISOString()
      }
    }, { 
      status: results.success ? 200 : (results.errors.length > 0 ? 207 : 500)
    });
    
  } catch (error) {
    console.error('❌ [ProjectAnalysis] Error general:', error);
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