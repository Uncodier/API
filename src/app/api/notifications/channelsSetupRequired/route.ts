import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { NotificationCategory } from '@/lib/services/notification-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { z } from 'zod';

// Configurar timeout máximo a 2 minutos
export const maxDuration = 120;

// Schema de validación para la request
const ChannelsSetupRequiredSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido')
});

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener team members del sitio con notificaciones habilitadas
async function getTeamMembersWithEmailNotifications(siteId: string): Promise<any[]> {
  return TeamNotificationService.getTeamMembersWithEmailNotifications(
    siteId,
    [NotificationCategory.SYSTEM_ALERTS]
  );
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

// Función para verificar configuración de canales del sitio
async function checkSiteChannelsConfiguration(siteId: string): Promise<{
  hasRequiredChannels: boolean,
  configuredChannels: string[],
  missingChannels: string[]
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    if (error || !data?.channels) {
      return {
        hasRequiredChannels: false,
        configuredChannels: [],
        missingChannels: ['email', 'whatsapp']
      };
    }
    
    const channels = data.channels;
    const configuredChannels: string[] = [];
    const requiredChannels = ['email', 'whatsapp'];
    
    // Verificar email
    if (channels.email && (channels.email.email || (channels.email.aliases && channels.email.aliases.length > 0))) {
      configuredChannels.push('email');
    }
    
    // Verificar WhatsApp
    if (channels.whatsapp && channels.whatsapp.phone_number) {
      configuredChannels.push('whatsapp');
    }
    
    const missingChannels = requiredChannels.filter(channel => !configuredChannels.includes(channel));
    const hasRequiredChannels = missingChannels.length === 0;
    
    return {
      hasRequiredChannels,
      configuredChannels,
      missingChannels
    };
    
  } catch (error) {
    console.error('Error al verificar configuración de canales del sitio:', error);
    return {
      hasRequiredChannels: false,
      configuredChannels: [],
      missingChannels: ['email', 'whatsapp']
    };
  }
}

// Funciones de branding consistentes
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

// Función para generar HTML del email para el team member
function generateChannelsSetupNotificationHtml(data: {
  teamMemberName: string;
  siteName: string;
  missingChannels: string[];
  logoUrl?: string;
  settingsUrl?: string;
  locale?: string;
}): string {
  const channelNames = {
    email: 'Email',
    whatsapp: 'WhatsApp'
  };
  
  const channelIcons = {
    email: '📧',
    whatsapp: '📱'
  };
  
  const missingChannelsList = data.missingChannels.map(channel => 
    `${channelIcons[channel as keyof typeof channelIcons]} ${channelNames[channel as keyof typeof channelNames]}`
  ).join(', ');
  
  return `
    <!DOCTYPE html>
    <html lang="${data.locale || 'en'}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
      <meta name="format-detection" content="telephone=no, date=no, email=no, address=no">
      <title>Channel Setup Required - ${data.siteName}</title>
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
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
      
      <!-- Main Container -->
      <div class="container" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="header email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div class="logo-container" style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img class="logo-image" src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block; margin: 0 auto;" />
          </div>
          ` : `
          <div class="logo-container" style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div class="logo-icon" style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 24px;">⚙️</div>
            </div>
          </div>
          `}
          <h1 class="main-title" style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; line-height: 1.2;">Channel Setup Required</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400; line-height: 1.4;">Configure channels to enable automatic prospecting</p>
        </div>
        
        <!-- Content -->
        <div class="content" style="padding: 40px;">
          
          <!-- Greeting -->
          <div class="section-spacing" style="margin-bottom: 32px;">
            <h2 class="section-title" style="margin: 0 0 16px; font-size: 20px; color: #111111; font-weight: 600; line-height: 1.3;">
              Hello ${data.teamMemberName}
            </h2>
            <p class="email-text" style="margin: 0; font-size: 16px; color: #111111; line-height: 1.7;">
              Your site <strong>${data.siteName}</strong> needs channel configuration to enable automatic prospecting. 
              At least one communication channel (Email or WhatsApp) must be set up to start generating and nurturing leads automatically.
            </p>
          </div>
          
          <!-- Missing Channels Alert -->
          <div class="section-spacing" style="margin-bottom: 32px;">
            <div class="card-padding" style="background-color: #fef2f2; padding: 20px 24px; border-radius: 8px; border: 1px solid #fecaca; text-align: center;">
              <h3 style="margin: 0 0 12px; font-size: 18px; color: #dc2626; font-weight: 600; line-height: 1.3;">⚠️ Configuration Required</h3>
              <p style="margin: 0; color: #991b1b; font-size: 16px; line-height: 1.6; word-break: break-word;">
                <strong>Missing channels:</strong> ${missingChannelsList}
              </p>
            </div>
          </div>
          
          <!-- Required Channels Information -->
          <div class="section-spacing" style="margin-bottom: 32px;">
            <h3 class="section-title" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600; line-height: 1.3;">Required Channels</h3>
            <div class="card-padding" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              
              <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #bfdbfe;">
                <div class="channel-content" style="display: flex; align-items: center; margin-bottom: 8px;">
                  <span class="channel-icon-mobile" style="font-size: 20px; margin-right: 8px; flex-shrink: 0;">📧</span>
                  <h4 class="channel-title-mobile" style="margin: 0; font-size: 16px; color: #3f6212; font-weight: 600; line-height: 1.3;">Email Channel</h4>
                </div>
                <p class="email-text" style="margin: 0; color: #111111; font-size: 14px; line-height: 1.6;">
                  Configure an email address to send automated email campaigns, follow-ups, and lead nurturing sequences.
                </p>
              </div>
              
              <div>
                <div class="channel-content" style="display: flex; align-items: center; margin-bottom: 8px;">
                  <span class="channel-icon-mobile" style="font-size: 20px; margin-right: 8px; flex-shrink: 0;">📱</span>
                  <h4 class="channel-title-mobile" style="margin: 0; font-size: 16px; color: #3f6212; font-weight: 600; line-height: 1.3;">WhatsApp Channel</h4>
                </div>
                <p class="email-text" style="margin: 0; color: #111111; font-size: 14px; line-height: 1.6;">
                  Set up WhatsApp integration for instant messaging, automated responses, and personalized customer communication.
                </p>
              </div>
              
            </div>
          </div>
          
          <!-- Why It Matters -->
          <div class="section-spacing" style="margin-bottom: 32px;">
            <h3 class="section-title" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600; line-height: 1.3;">Why Channel Setup Matters</h3>
            <div class="card-padding" style="background-color: #f0fdf4; padding: 20px 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul class="benefits-list" style="margin: 0; padding-left: 20px; color: #166534; font-size: 14px; line-height: 1.6;">
                <li style="margin-bottom: 8px;"><strong>Automatic Lead Generation:</strong> Start capturing and qualifying leads 24/7</li>
                <li style="margin-bottom: 8px;"><strong>Instant Follow-ups:</strong> Respond to prospects immediately when they show interest</li>
                <li style="margin-bottom: 8px;"><strong>Personalized Outreach:</strong> Send targeted messages based on visitor behavior</li>
                <li style="margin-bottom: 0;"><strong>Higher Conversion Rates:</strong> Engage prospects through their preferred communication channel</li>
              </ul>
            </div>
          </div>
          
          <!-- Action Button -->
          <div style="text-align: center; margin: 40px 0 32px;">
            ${data.settingsUrl ? `
            <a class="button email-cta" href="${data.settingsUrl}" 
               style="display: inline-block; background-color: #000000; color: #ffffff; border: 1px solid #000000; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; min-height: 44px; line-height: 1.3; text-align: center; box-sizing: border-box; -webkit-appearance: none; -moz-appearance: none;">
              Configure Channels Now →
            </a>
            ` : `
            <div class="button email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; min-height: 44px; line-height: 1.3; text-align: center; box-sizing: border-box;">
              Visit your site settings to configure channels
            </div>
            `}
          </div>
          
          <!-- Urgency Notice -->
          <div class="section-spacing" style="margin-top: 32px; margin-bottom: 24px;">
            <div class="card-padding" style="padding: 16px 24px; background-color: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; text-align: center;">
              <p style="margin: 0; color: #c2410c; font-size: 14px; font-weight: 600; line-height: 1.5;">
                🚀 Set up channels now to start automated prospecting and maximize your lead generation potential
              </p>
            </div>
          </div>
          
          <!-- Help Information -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
              Need help setting up your channels? Contact our support team or check our documentation for step-by-step guides.
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div class="footer" style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="footer-text" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
            This notification was automatically generated by ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 10px;">
        <p class="email-subtle" style="margin: 0; color: #71717a; font-size: 12px; line-height: 1.4;">
          Powered by <strong style="color: #000000;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('⚙️ [ChannelsSetup] Iniciando notificación de configuración de canales requerida');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = ChannelsSetupRequiredSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [ChannelsSetup] Error de validación:', validationResult.error.errors);
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
    
    console.log(`⚙️ [ChannelsSetup] Verificando configuración de canales para sitio: ${site_id}`);
    
    // Verificar configuración de canales del sitio
    const channelsConfig = await checkSiteChannelsConfiguration(site_id);
    
    if (channelsConfig.hasRequiredChannels) {
      console.log(`✅ [ChannelsSetup] Sitio ${site_id} ya tiene los canales requeridos configurados: ${channelsConfig.configuredChannels.join(', ')}`);
      return NextResponse.json({
        success: true,
        message: 'Site already has required channels configured',
        data: {
          site_id,
          channels_configured: true,
          configured_channels: channelsConfig.configuredChannels,
          notification_sent: false
        }
      });
    }
    
    console.log(`⚠️ [ChannelsSetup] Sitio ${site_id} necesita configuración de canales. Canales faltantes: ${channelsConfig.missingChannels.join(', ')}`);
    
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
    
    // Obtener team members del sitio
    const teamMembers = await getTeamMembersWithEmailNotifications(site_id);
    
    if (teamMembers.length === 0) {
      console.warn(`⚠️ [ChannelsSetup] No se encontraron team members con notificaciones habilitadas para el sitio: ${site_id}`);
      return NextResponse.json({
        success: true,
        message: 'No team members with email notifications enabled found',
        data: {
          site_id,
          channels_configured: false,
          missing_channels: channelsConfig.missingChannels,
          notification_sent: false,
          team_members_found: 0
        }
      });
    }
    
    // URLs para los emails
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const settingsUrl = `${baseUrl}/settings`;
    
    let emailsSent = 0;
    let emailsErrors = 0;
    
    console.log(`📧 [ChannelsSetup] Enviando notificaciones a ${teamMembers.length} team members:`);
    
    for (const member of teamMembers) {
      try {
        console.log(`📧 [ChannelsSetup] Notificando a ${member.name} (${member.email})`);
        
        const locale = await (await import('@/lib/i18n/email-locale')).resolveEmailLocale({
          siteId: site_id,
          userId: member.user_id,
        });

        const emailResult = await sendGridService.sendEmail({
          to: member.email,
          subject: (await import('@/lib/i18n/email-messages/platform')).platformT(
            locale,
            'channels_setup.subject',
            { siteName: siteInfo.name }
          ),
          html: generateChannelsSetupNotificationHtml({
            teamMemberName: member.name || 'Team Member',
            siteName: siteInfo.name || 'Your Site',
            missingChannels: channelsConfig.missingChannels,
            logoUrl: siteInfo.logo_url,
            settingsUrl: settingsUrl,
            locale
          }),
          categories: [NotificationCategory.SYSTEM_ALERTS],
          customArgs: {
            siteId: site_id,
            teamMemberId: member.user_id,
            missingChannels: channelsConfig.missingChannels.join(','),
            notificationType: 'channels_setup_required'
          }
        });
        
        if (emailResult.success) {
          emailsSent++;
          console.log(`✅ [ChannelsSetup] Notificación enviada exitosamente a ${member.email}`);
        } else {
          emailsErrors++;
          console.error(`❌ [ChannelsSetup] Error enviando email a ${member.email}: ${emailResult.error}`);
        }
        
      } catch (error) {
        emailsErrors++;
        console.error(`❌ [ChannelsSetup] Error enviando notificación a ${member.email}:`, error);
      }
    }
    
    console.log(`📊 [ChannelsSetup] Notificaciones completadas: ${emailsSent} exitosas, ${emailsErrors} fallidas`);
    
    return NextResponse.json({
      success: true,
      data: {
        site_id,
        channels_configured: false,
        missing_channels: channelsConfig.missingChannels,
        configured_channels: channelsConfig.configuredChannels,
        notification_sent: true,
        team_members_notified: emailsSent,
        total_team_members: teamMembers.length,
        emails_sent: emailsSent,
        email_errors: emailsErrors,
        sent_at: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('❌ [ChannelsSetup] Error general:', error);
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