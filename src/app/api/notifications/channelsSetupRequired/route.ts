import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
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
  try {
    console.log(`🔍 [ChannelsSetup] Obteniendo miembros del equipo para el sitio: ${siteId}`);
    
    // Obtener propietarios del sitio (site_ownership)
    const { data: siteOwners, error: siteOwnersError } = await supabaseAdmin
      .from('site_ownership')
      .select('user_id')
      .eq('site_id', siteId);
    
    if (siteOwnersError) {
      console.error('Error al obtener site_owners:', siteOwnersError);
      return [];
    }
    
    // Obtener miembros del sitio (site_members)
    const { data: siteMembers, error: siteMembersError } = await supabaseAdmin
      .from('site_members')
      .select('user_id, role')
      .eq('site_id', siteId)
      .eq('status', 'active');
    
    if (siteMembersError) {
      console.error('Error al obtener site_members:', siteMembersError);
      return [];
    }
    
    // Combinar propietarios y miembros, evitando duplicados
    const allUsers = new Map<string, { user_id: string; role: string }>();
    
    // Agregar propietarios con rol 'owner'
    if (siteOwners) {
      siteOwners.forEach(owner => {
        allUsers.set(owner.user_id, {
          user_id: owner.user_id,
          role: 'owner'
        });
      });
      console.log(`🔑 [ChannelsSetup] Encontrados ${siteOwners.length} propietarios en site_ownership`);
    }
    
    // Agregar miembros (si ya existe como propietario, no sobrescribir)
    if (siteMembers) {
      siteMembers.forEach(member => {
        if (!allUsers.has(member.user_id)) {
          allUsers.set(member.user_id, {
            user_id: member.user_id,
            role: member.role
          });
        }
      });
      console.log(`👥 [ChannelsSetup] Encontrados ${siteMembers.length} miembros en site_members`);
    }
    
    const totalUniqueUsers = Array.from(allUsers.values());
    
    if (totalUniqueUsers.length === 0) {
      console.warn(`[ChannelsSetup] No se encontraron miembros ni propietarios para el sitio: ${siteId}`);
      return [];
    }
    
    console.log(`📋 [ChannelsSetup] Total de usuarios únicos: ${totalUniqueUsers.length}`);
    
    // Obtener información de los usuarios de auth
    const teamMembers = [];
    for (const userInfo of totalUniqueUsers) {
      try {
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userInfo.user_id);
        
        if (!userError && userData.user && userData.user.email) {
          // Obtener perfil para verificar notificaciones
          const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('notifications')
            .eq('id', userInfo.user_id)
            .single();
          
          const notifications = profile?.notifications || {};
          const emailNotificationsEnabled = notifications.email !== false; // Por defecto habilitadas
          
          if (emailNotificationsEnabled) {
            teamMembers.push({
              user_id: userInfo.user_id,
              email: userData.user.email,
              name: userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || userData.user.email,
              role: userInfo.role
            });
          }
        }
      } catch (error) {
        console.warn(`[ChannelsSetup] Error obteniendo usuario ${userInfo.user_id}:`, error);
      }
    }
    
    console.log(`✅ [ChannelsSetup] ${teamMembers.length} miembros con notificaciones por email habilitadas`);
    return teamMembers;
    
  } catch (error) {
    console.error('[ChannelsSetup] Error al obtener miembros del equipo:', error);
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
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Función para generar HTML del email para el team member
function generateChannelsSetupNotificationHtml(data: {
  teamMemberName: string;
  siteName: string;
  missingChannels: string[];
  logoUrl?: string;
  settingsUrl?: string;
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
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
      <meta name="format-detection" content="telephone=no, date=no, email=no, address=no">
      <title>Channel Setup Required - ${data.siteName}</title>
      <style>
        /* Mobile-first responsive design */
        @media screen and (max-width: 600px) {
          .container {
            margin: 10px !important;
            border-radius: 8px !important;
          }
          .header {
            padding: 24px 20px !important;
          }
          .content {
            padding: 24px 20px !important;
          }
          .footer {
            padding: 20px !important;
          }
          .section-spacing {
            margin-bottom: 24px !important;
          }
          .card-padding {
            padding: 16px 18px !important;
          }
          .button {
            padding: 14px 24px !important;
            font-size: 15px !important;
            min-height: 44px !important;
            width: auto !important;
            display: block !important;
            max-width: 280px !important;
            margin: 0 auto !important;
            box-sizing: border-box !important;
          }
          .logo-container {
            width: 80px !important;
            height: 80px !important;
            padding: 12px !important;
          }
          .logo-image {
            width: 56px !important;
            height: 56px !important;
          }
          .logo-icon {
            width: 40px !important;
            height: 40px !important;
            padding: 20px !important;
          }
          .main-title {
            font-size: 22px !important;
            line-height: 1.3 !important;
          }
          .section-title {
            font-size: 16px !important;
            line-height: 1.4 !important;
          }
          .channel-icon-mobile {
            display: block !important;
            text-align: center !important;
            margin-bottom: 8px !important;
          }
          .channel-title-mobile {
            text-align: center !important;
            margin-bottom: 12px !important;
          }
          .channel-content {
            flex-direction: column !important;
            align-items: flex-start !important;
          }
          .benefits-list {
            padding-left: 16px !important;
          }
          .footer-text {
            font-size: 13px !important;
          }
        }
        
        /* Dark mode support */
        @media (prefers-color-scheme: dark) {
          .dark-mode-text {
            color: #e2e8f0 !important;
          }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
      
      <!-- Main Container -->
      <div class="container" style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div class="logo-container" style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img class="logo-image" src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block; margin: 0 auto;" />
          </div>
          ` : `
          <div class="logo-container" style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div class="logo-icon" style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 24px;">⚙️</div>
            </div>
          </div>
          `}
          <h1 class="main-title" style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; line-height: 1.2;">Channel Setup Required</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400; line-height: 1.4;">Configure channels to enable automatic prospecting</p>
        </div>
        
        <!-- Content -->
        <div class="content" style="padding: 40px;">
          
          <!-- Greeting -->
          <div class="section-spacing" style="margin-bottom: 32px;">
            <h2 class="section-title" style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600; line-height: 1.3;">
              Hello ${data.teamMemberName}
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
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
            <h3 class="section-title" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600; line-height: 1.3;">Required Channels</h3>
            <div class="card-padding" style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              
              <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #bfdbfe;">
                <div class="channel-content" style="display: flex; align-items: center; margin-bottom: 8px;">
                  <span class="channel-icon-mobile" style="font-size: 20px; margin-right: 8px; flex-shrink: 0;">📧</span>
                  <h4 class="channel-title-mobile" style="margin: 0; font-size: 16px; color: #1e40af; font-weight: 600; line-height: 1.3;">Email Channel</h4>
                </div>
                <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.6;">
                  Configure an email address to send automated email campaigns, follow-ups, and lead nurturing sequences.
                </p>
              </div>
              
              <div>
                <div class="channel-content" style="display: flex; align-items: center; margin-bottom: 8px;">
                  <span class="channel-icon-mobile" style="font-size: 20px; margin-right: 8px; flex-shrink: 0;">📱</span>
                  <h4 class="channel-title-mobile" style="margin: 0; font-size: 16px; color: #1e40af; font-weight: 600; line-height: 1.3;">WhatsApp Channel</h4>
                </div>
                <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.6;">
                  Set up WhatsApp integration for instant messaging, automated responses, and personalized customer communication.
                </p>
              </div>
              
            </div>
          </div>
          
          <!-- Why It Matters -->
          <div class="section-spacing" style="margin-bottom: 32px;">
            <h3 class="section-title" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600; line-height: 1.3;">Why Channel Setup Matters</h3>
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
            <a class="button" href="${data.settingsUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; min-height: 44px; line-height: 1.3; text-align: center; box-sizing: border-box; -webkit-appearance: none; -moz-appearance: none;">
              Configure Channels Now →
            </a>
            ` : `
            <div class="button" style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; padding: 16px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; min-height: 44px; line-height: 1.3; text-align: center; box-sizing: border-box;">
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
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              Need help setting up your channels? Contact our support team or check our documentation for step-by-step guides.
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div class="footer" style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="footer-text" style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            This notification was automatically generated by ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 10px;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.4;">
          Powered by <strong style="color: #f59e0b;">${getBrandingText()}</strong>
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
    const settingsUrl = `${baseUrl}/sites/${site_id}/settings`;
    
    let emailsSent = 0;
    let emailsErrors = 0;
    
    console.log(`📧 [ChannelsSetup] Enviando notificaciones a ${teamMembers.length} team members:`);
    
    for (const member of teamMembers) {
      try {
        console.log(`📧 [ChannelsSetup] Notificando a ${member.name} (${member.email})`);
        
        const emailResult = await sendGridService.sendEmail({
          to: member.email,
          subject: `⚙️ Channel Setup Required: Enable Automatic Prospecting for ${siteInfo.name}`,
          html: generateChannelsSetupNotificationHtml({
            teamMemberName: member.name || 'Team Member',
            siteName: siteInfo.name || 'Your Site',
            missingChannels: channelsConfig.missingChannels,
            logoUrl: siteInfo.logo_url,
            settingsUrl: settingsUrl
          }),
          categories: ['channels-setup', 'team-notification', 'configuration-required'],
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