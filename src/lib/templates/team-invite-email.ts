import { EmailSendService } from '../services/email/EmailSendService';

/**
 * Template para emails de invitación a equipos
 */

export interface TeamInviteEmailData {
  memberName: string;
  memberEmail: string;
  role: string;
  position: string;
  siteName: string;
  signUpUrl?: string;
}

/**
 * Obtiene el texto de branding desde variables de entorno
 */
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

/**
 * Obtiene la URL de sign up desde variables de entorno
 */
function getSignUpUrl(override?: string): string {
  if (override) return override;
  return process.env.NEXT_PUBLIC_APP_URL 
    ? `${process.env.NEXT_PUBLIC_APP_URL}/signup` 
    : 'https://app.uncodie.com/signup';
}

/**
 * Obtiene el email de soporte desde variables de entorno
 */
function getSupportEmail(): string {
  return process.env.UNCODIE_SUPPORT_EMAIL || 'support@uncodie.com';
}

/**
 * Obtiene el nombre de la compañía desde variables de entorno
 */
function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

/**
 * Obtiene el tagline de la compañía desde variables de entorno
 */
function getCompanyTagline(): string {
  return process.env.UNCODIE_COMPANY_TAGLINE || 'AI-powered team collaboration';
}

/**
 * Genera el HTML para el email de invitación al equipo
 */
export function generateTeamInviteHtml(data: TeamInviteEmailData): string {
  // Mapeo de roles a etiquetas legibles
  const roleLabels = {
    'view': 'Viewer (View only)',
    'create': 'Editor (Create and edit)',
    'delete': 'Manager (Full access)',
    'admin': 'Admin (Owner privileges)'
  };

  const roleLabel = roleLabels[data.role as keyof typeof roleLabels] || data.role;
  
  // Configuración de colores por rol
  const roleColors = {
    'view': { color: '#10b981', bg: '#ecfdf5' },
    'create': { color: '#3b82f6', bg: '#eff6ff' },
    'delete': { color: '#f59e0b', bg: '#fffbeb' },
    'admin': { color: '#8b5cf6', bg: '#f3e8ff' }
  };
  
  const roleColor = roleColors[data.role as keyof typeof roleColors] || roleColors.view;

  const escapedMemberName = EmailSendService.escapeHtml(data.memberName);
  const escapedSiteName = EmailSendService.escapeHtml(data.siteName);
  const escapedMemberEmail = EmailSendService.escapeHtml(data.memberEmail);
  const escapedPosition = EmailSendService.escapeHtml(data.position);
  const escapedCompanyName = EmailSendService.escapeHtml(getCompanyName());
  const escapedBrandingText = EmailSendService.escapeHtml(getBrandingText());
  const escapedCompanyTagline = EmailSendService.escapeHtml(getCompanyTagline());
  const escapedRoleLabel = EmailSendService.escapeHtml(roleLabel);

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>You're Invited to Join ${escapedSiteName} on ${escapedCompanyName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 50%; position: relative; display: flex; align-items: center; justify-content: center;">
              <div style="width: 12px; height: 12px; background-color: #667eea; border-radius: 50%;"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">You're Invited!</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Join ${escapedSiteName} team on ${escapedCompanyName}</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Welcome Message -->
          <div style="margin-bottom: 32px; text-align: center;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">
              Hi ${escapedMemberName}! 👋
            </h2>
            <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
              You've been invited to join the <strong>${escapedSiteName}</strong> team on ${escapedCompanyName}. 
              We're excited to have you collaborate with us!
            </p>
          </div>
          
          <!-- Role Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${roleColor.bg}; color: ${roleColor.color}; padding: 12px 20px; border-radius: 25px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${escapedRoleLabel}
            </div>
          </div>
          
          <!-- Team Details -->
          <div style="margin-bottom: 32px;">
            <div style="background-color: #f8fafc; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <h3 style="margin: 0 0 16px; font-size: 16px; color: #1e293b; font-weight: 600;">Your Team Details</h3>
              
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #475569; min-width: 80px;">Team:</span>
                <span style="color: #1e293b; font-size: 15px;">${escapedSiteName}</span>
              </div>
              
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #475569; min-width: 80px;">Position:</span>
                <span style="color: #1e293b; font-size: 15px;">${escapedPosition}</span>
              </div>
              
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #475569; min-width: 80px;">Role:</span>
                <span style="color: #1e293b; font-size: 15px;">${escapedRoleLabel}</span>
              </div>
              
              <div>
                <span style="display: inline-block; font-weight: 600; color: #475569; min-width: 80px;">Email:</span>
                <span style="color: #1e293b; font-size: 15px;">${escapedMemberEmail}</span>
              </div>
            </div>
          </div>
          
          <!-- Features List -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 20px; font-size: 18px; color: #1e293b; font-weight: 600;">What you can do with ${escapedCompanyName}:</h3>
            <div style="space-y: 12px;">
              <div style="display: flex; align-items: start; margin-bottom: 12px;">
                <div style="background-color: #10b981; width: 6px; height: 6px; border-radius: 50%; margin-top: 8px; margin-right: 12px; flex-shrink: 0;"></div>
                <span style="color: #475569; font-size: 15px; line-height: 1.6;">Get leads and automate intelligent follow-up sequences</span>
              </div>
              <div style="display: flex; align-items: start; margin-bottom: 12px;">
                <div style="background-color: #10b981; width: 6px; height: 6px; border-radius: 50%; margin-top: 8px; margin-right: 12px; flex-shrink: 0;"></div>
                <span style="color: #475569; font-size: 15px; line-height: 1.6;">Collaborate with your team in real-time across all campaigns</span>
              </div>
              <div style="display: flex; align-items: start; margin-bottom: 12px;">
                <div style="background-color: #10b981; width: 6px; height: 6px; border-radius: 50%; margin-top: 8px; margin-right: 12px; flex-shrink: 0;"></div>
                <span style="color: #475569; font-size: 15px; line-height: 1.6;">Access advanced analytics and conversion insights</span>
              </div>
              <div style="display: flex; align-items: start; margin-bottom: 12px;">
                <div style="background-color: #10b981; width: 6px; height: 6px; border-radius: 50%; margin-top: 8px; margin-right: 12px; flex-shrink: 0;"></div>
                <span style="color: #475569; font-size: 15px; line-height: 1.6;">Create compelling content for your brand automatically</span>
              </div>
              <div style="display: flex; align-items: start;">
                <div style="background-color: #10b981; width: 6px; height: 6px; border-radius: 50%; margin-top: 8px; margin-right: 12px; flex-shrink: 0;"></div>
                <span style="color: #475569; font-size: 15px; line-height: 1.6;">Control your AI-generated tasks and close more deals</span>
              </div>
            </div>
          </div>
          
          <!-- Action Button -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${EmailSendService.escapeAttr(getSignUpUrl(data.signUpUrl))}" 
               style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s;">
              Join Team →
            </a>
          </div>
          
          <!-- Help Section -->
          <div style="text-align: center; margin-bottom: 24px; padding: 20px; background-color: #f1f5f9; border-radius: 8px; border: 1px solid #e2e8f0;">
            <p style="margin: 0 0 12px; color: #475569; font-size: 14px;">
              <strong>New to ${escapedCompanyName}?</strong> No worries! The sign-up process is quick and easy.
            </p>
            <p style="margin: 0; color: #475569; font-size: 14px;">
              Once you create your account, you'll automatically have access to ${escapedSiteName} with your assigned role.
            </p>
          </div>
          
          <!-- Footer -->
          <div style="text-align: center; padding-top: 24px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0 0 12px; color: #64748b; font-size: 14px;">
              This invitation was sent to <strong>${escapedMemberEmail}</strong>
            </p>
            <p style="margin: 0; color: #64748b; font-size: 12px;">
              If you didn't expect this invitation, you can safely ignore this email.
            </p>
          </div>
        </div>
      </div>
      
      <!-- Powered by Uncodie -->
      <div style="text-align: center; margin: 20px 0 40px;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong>${escapedBrandingText}</strong> • ${escapedCompanyTagline}
        </p>
      </div>
      
    </body>
    </html>
  `;
}