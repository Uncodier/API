import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType, NotificationCategory } from '@/lib/services/notification-service';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const DailyStandUpSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  subject: z.string().min(1, 'subject es requerido'),
  message: z.string().min(1, 'message es requerido'),
  health: z
    .object({
      status: z
        .union([z.enum(['GREEN', 'YELLOW', 'RED']), z.string()])
        .optional(),
      reason: z.string().optional(),
      priorities: z.array(z.string()).optional(),
    })
    .optional(),
  systemAnalysis: z.object({
    success: z.boolean(),
    command_id: z.string(),
    strategic_analysis: z.object({
      business_assessment: z.string(),
      focus_areas: z.union([
        z.array(z.string()),
        z.record(z.string()),
        z.object({}).passthrough()
      ]).optional().transform((value) => {
        if (!value) return undefined;
        
        // Si ya es un array, devolverlo tal como está
        if (Array.isArray(value)) {
          return value;
        }
        
        // Si es un objeto, intentar convertirlo a array
        if (typeof value === 'object' && value !== null) {
          // Caso 1: Objeto con propiedades numéricas {0: "value1", 1: "value2"}
          const keys = Object.keys(value);
          const numericKeys = keys.filter(key => !isNaN(parseInt(key))).sort((a, b) => parseInt(a) - parseInt(b));
          
          if (numericKeys.length > 0) {
            return numericKeys.map(key => String(value[key]));
          }
          
          // Caso 2: Objeto con valores como array
          const values = Object.values(value);
          if (values.length > 0) {
            return values.map(val => String(val));
          }
          
          // Caso 3: Objeto complejo, extraer strings
          return Object.entries(value)
            .filter(([_, val]) => typeof val === 'string' && val.trim().length > 0)
            .map(([_, val]) => String(val));
        }
        
        // Si no se puede convertir, devolver array vacío
        return [];
      })
    }).optional(),
    analysis_type: z.string(),
    system_data: z.any().optional()
  }).optional()
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

// Funciones de branding
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

// Función para formatear el business assessment de manera humana y relevante para email
function formatBusinessAssessment(assessment: string): string {
  // Extraer secciones clave y formatear para HTML
  const lines = assessment.split('\n').filter(line => {
    const lowLine = line.toLowerCase();
    // Filtrar líneas técnicas innecesarias
    return !lowLine.includes('executive briefing') &&
           !lowLine.includes('rationale:') &&
           !lowLine.includes('preventive measures') &&
           !lowLine.includes('apple/netflix') &&
           !lowLine.includes('bain-style') &&
           !lowLine.includes('in summary') &&
           line.trim().length > 0;
  });

  let htmlContent = '';
  let currentSection = '';
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Detectar títulos principales (números seguidos de mayúsculas)
    if (/^\d+\.\s+([A-Z\s&]+)/.test(trimmedLine)) {
      const title = trimmedLine.replace(/^\d+\.\s+/, '').toLowerCase()
        .replace(/assessment/g, 'status')
        .replace(/analysis/g, 'review')
        .replace(/strategic/g, '')
        .replace(/&/g, 'and')
        .trim();
      currentSection = title.charAt(0).toUpperCase() + title.slice(1);
      htmlContent += `<div style="margin: 16px 0;"><strong class="email-text" style="color: #111111; font-size: 16px;">${currentSection}</strong></div>`;
      continue;
    }
    
    // Detectar status
    if (trimmedLine.startsWith('Status:')) {
      const status = trimmedLine.replace('Status:', '').trim();
      const color = status.includes('RED') ? '#dc2626' : status.includes('YELLOW') ? '#d97706' : '#059669';
      const emoji = status.includes('RED') ? '🔴' : status.includes('YELLOW') ? '🟡' : '🟢';
      htmlContent += `<div style="margin: 8px 0; padding: 8px 12px; background-color: ${color}15; border-left: 3px solid ${color}; border-radius: 4px;">
        <span style="margin-right: 6px;">${emoji}</span><span style="color: #374151;">${status}</span>
      </div>`;
      continue;
    }
    
    // Detectar secciones de prioridades/acciones
    if (trimmedLine.includes('Priorities') || trimmedLine.includes('Quick Wins') || trimmedLine.includes('Critical')) {
      htmlContent += `<div style="margin: 12px 0;"><strong style="color: #000000; font-weight: 600;">${trimmedLine.replace(/:/g, '')}</strong></div>`;
      continue;
    }
    
    // Formatear bullets (normaliza prefijos '-', '•', '• -')
    if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('•') || trimmedLine.startsWith('• -')) {
      const normalized = trimmedLine
        .replace(/^•\s*-\s*/,'')
        .replace(/^•\s*/,'')
        .replace(/^\-\s*/,'');
      const bulletText = normalized;
      // Cortar bullets muy largos
      const shortText = bulletText.length > 120 ? bulletText.substring(0, 120) + '...' : bulletText;
      htmlContent += `<div style="margin: 4px 0 4px 16px; color: #4b5563; font-size: 14px;">• ${shortText}</div>`;
      continue;
    }
    
    // Otras líneas importantes (concerns, etc.)
    if (trimmedLine.length > 10 && !trimmedLine.includes('Rationale') && !trimmedLine.includes('Priority Actions')) {
      const shortLine = trimmedLine.length > 150 ? trimmedLine.substring(0, 150) + '...' : trimmedLine;
      htmlContent += `<div class="email-muted" style="margin: 6px 0; color: #6b7280; font-size: 14px;">${shortLine}</div>`;
    }
  }
  
  // Limitar el contenido total para el email
  if (htmlContent.length > 1200) {
    htmlContent = htmlContent.substring(0, 1200) + '<div style="color: #9ca3af; font-style: italic; margin-top: 8px;">...</div>';
  }
  
  return htmlContent;
}

// Function to generate daily standup HTML (casual tone)
function generateDailyStandUpHtml(data: {
  subject: string;
  message: string;
  siteName: string;
  siteUrl?: string;
  logoUrl?: string;
  businessAssessment?: string;
  locale?: string;
}): string {
  const currentDate = new Date().toLocaleDateString(data.locale === 'es' ? 'es-ES' : data.locale === 'fr' ? 'fr-FR' : data.locale === 'de' ? 'de-DE' : data.locale === 'ja' ? 'ja-JP' : 'en-US', {
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const resolvedSubject = data.subject && data.subject.trim().length > 0
    ? data.subject
    : 'Daily Stand-Up';
  const safeSubject = EmailSendService.escapeHtml(resolvedSubject);
  const headerTitle = safeSubject;
  const safeMessageHtml = EmailSendService.renderMessageWithLists(data.message);
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
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeSubject} - ${EmailSendService.escapeHtml(data.siteName)}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
    <!-- Header -->
    <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
      ${data.logoUrl ? `
      <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
        <img src="${EmailSendService.escapeAttr(data.logoUrl)}" alt="${EmailSendService.escapeHtml(data.siteName)} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
      </div>
      ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #90ff17; font-weight: 600; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">☀️ ${headerTitle}</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">${currentDate}</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Main Message (plain, no colored container) -->
          <div style="margin-bottom: 32px;">
            <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">
              ${safeMessageHtml}
            </div>
          </div>
          
          <!-- Business Assessment (if available) -->
          ${data.businessAssessment ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">📊 System Health & Priorities</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 24px; border-radius: 8px; border-left: 4px solid #90ff17; border: 1px solid #e4e4e7;">
              <div class="email-text" style="color: #111111; font-size: 15px; line-height: 1.6; font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;">
                ${formatBusinessAssessment(data.businessAssessment)}
              </div>
            </div>
            <div style="margin-top: 16px; padding: 12px; background-color: #f0f9ff; border-radius: 6px; border-left: 3px solid #0ea5e9;">
              <p style="margin: 0; color: #0369a1; font-size: 13px; line-height: 1.4; font-style: italic;">
                💡 Key insights from your system analysis to guide this week's priorities.
              </p>
            </div>
          </div>
          ` : ''}
          
      <!-- Call-to-Action -->
      ${data.siteUrl ? `
      <div style="text-align: center; margin: 40px 0 32px;">
        <a href="${EmailSendService.escapeAttr(data.siteUrl)}" 
           class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          🚀 View Dashboard
        </a>
      </div>
      ` : ''}

          <!-- Friendly Note -->
          <div style="margin-top: 32px; padding: 16px; background-color: #fef3c7; border-radius: 6px; border-left: 3px solid #90ff17;">
            <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.5;">
              <strong>💡 Remember:</strong> This is just an automated summary. If you need more details or have questions, don't hesitate to review the complete dashboard.
            </p>
          </div>
          
          <!-- Team Spirit -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
              Have an excellent day! 🌟<br>
              <em>Your AI team working 24/7 for you</em>
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
            Daily summary automatically generated by ${getCompanyName()}.<br>
            You can adjust your notification preferences in your account settings.
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
    console.log('☀️ [DailyStandUp] Iniciando notificación diaria');
    
    const body = await request.json();
    
    // Debug: Log the structure of systemAnalysis if it exists
    if (body.systemAnalysis?.strategic_analysis?.focus_areas) {
      const focusAreas = body.systemAnalysis.strategic_analysis.focus_areas;
      console.log('🔍 [DailyStandUp] Debug - focus_areas type:', typeof focusAreas);
      console.log('🔍 [DailyStandUp] Debug - focus_areas isArray:', Array.isArray(focusAreas));
      console.log('🔍 [DailyStandUp] Debug - focus_areas value:', JSON.stringify(focusAreas));
    }
    
    // Validar el cuerpo de la request
    const validationResult = DailyStandUpSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [DailyStandUp] Error de validación:', validationResult.error.errors);
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
    
    // Debug: Log the transformed focus_areas after validation
    if (validationResult.data.systemAnalysis?.strategic_analysis?.focus_areas) {
      console.log('✅ [DailyStandUp] Debug - transformed focus_areas:', JSON.stringify(validationResult.data.systemAnalysis.strategic_analysis.focus_areas));
    }
    
    const { site_id, subject, message, systemAnalysis, health } = validationResult.data;
    
    console.log(`📋 [DailyStandUp] Procesando notificación para sitio: ${site_id}`);
    
    // Extraer business assessment del systemAnalysis si está disponible
    let businessAssessment: string | undefined;

    // 1) Construir desde health si está disponible (tiene prioridad)
    if (health) {
      const statusUpper = health.status ? String(health.status).toUpperCase() : undefined;
      const statusPart = statusUpper
        ? `Status: ${statusUpper}${health.reason ? ' - ' + health.reason : ''}`
        : health.reason || '';
      const prioritiesPart = Array.isArray(health.priorities) && health.priorities.length > 0
        ? '\n' + health.priorities
            .map((p: string) => {
              const cleaned = String(p).replace(/^\s*[•\-]\s*/, '');
              return `- ${cleaned}`;
            })
            .join('\n')
        : '';
      const composed = `${statusPart}${prioritiesPart}`.trim();
      if (composed.length > 0) {
        businessAssessment = composed;
        console.log('📊 [DailyStandUp] Business assessment construido desde health (prioritario)');
      }
    }

    // 2) Si no hay health utilizable, usar el de systemAnalysis
    if (!businessAssessment && systemAnalysis?.strategic_analysis?.business_assessment) {
      businessAssessment = systemAnalysis.strategic_analysis.business_assessment;
      console.log('📊 [DailyStandUp] Business assessment extraído del systemAnalysis');
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
    
    const results = {
      success: true,
      notifications_sent: 0,
      emails_sent: 0,
      errors: [] as string[]
    };
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const dashboardUrl = `${baseUrl}/dashboard`;
    
    // Enviar notificación al equipo
    console.log('📢 [DailyStandUp] Enviando notificación al equipo...');
    
    try {
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: site_id,
        title: subject,
        message: `Daily summary for ${siteInfo.name}: ${message}`,
        buildEmail: (locale) => ({
          subject,
          html: generateDailyStandUpHtml({
            subject,
            message,
            siteName: siteInfo.name || 'Your Site',
            siteUrl: dashboardUrl,
            logoUrl: siteInfo.logo_url,
            businessAssessment,
            locale
          })
        }),
        priority: 'normal',
        type: NotificationType.INFO,
        categories: [NotificationCategory.ANALYSIS_INSIGHTS],
        customArgs: {
          siteId: site_id,
          reportType: 'daily_standup',
          generatedAt: new Date().toISOString()
        },
        relatedEntityType: 'site',
        relatedEntityId: site_id
      });
      
      if (teamNotificationResult.success) {
        results.notifications_sent = teamNotificationResult.notificationsSent;
        results.emails_sent = teamNotificationResult.emailsSent;
        console.log(`✅ [DailyStandUp] Equipo notificado: ${teamNotificationResult.notificationsSent} notificaciones, ${teamNotificationResult.emailsSent} emails`);
      } else {
        const errorMsg = `Failed to notify team: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`;
        results.errors.push(errorMsg);
        results.success = false;
        console.error(`❌ [DailyStandUp] ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = `Error notifying team: ${error instanceof Error ? error.message : 'Unknown error'}`;
      results.errors.push(errorMsg);
      results.success = false;
      console.error(`❌ [DailyStandUp] ${errorMsg}`, error);
    }
    
    console.log(`📊 [DailyStandUp] Resumen de notificaciones:`, {
      success: results.success,
      notifications_sent: results.notifications_sent,
      emails_sent: results.emails_sent,
      errors: results.errors.length,
      site_name: siteInfo.name
    });
    
    return NextResponse.json({
      success: results.success,
      data: {
        site_id,
        site_info: {
          name: siteInfo.name,
          url: siteInfo.url
        },
        subject,
        message,
        notifications_sent: results.notifications_sent,
        emails_sent: results.emails_sent,
        total_recipients: results.notifications_sent,
        errors: results.errors.length > 0 ? results.errors : undefined,
        sent_at: new Date().toISOString(),
        business_assessment_included: !!businessAssessment
      }
    }, { 
      status: results.success ? 200 : 500
    });
    
  } catch (error) {
    console.error('❌ [DailyStandUp] Error general:', error);
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