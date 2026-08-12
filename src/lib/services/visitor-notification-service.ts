import { sendGridService } from './sendgrid-service';
import { EmailSendService } from './email/EmailSendService';
import { resolveEmailLocale, type EmailLocale, DEFAULT_EMAIL_LOCALE } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { EMAIL_BRAND, emailBrandHeadTags } from '@/lib/emails/brand';

/**
 * Parámetros para notificar al visitante
 */
export interface NotifyVisitorParams {
  visitorEmail: string;
  visitorName?: string;
  message: string;
  agentName?: string;
  summary?: string;
  supportEmail?: string;
  siteId?: string;
}

/**
 * Resultado de la notificación al visitante
 */
export interface NotifyVisitorResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Servicio especializado para notificaciones a visitantes
 */
export class VisitorNotificationService {
  
  /**
   * Obtiene el texto de branding desde variables de entorno
   */
  private static getBrandingText(): string {
    return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
  }
  
  /**
   * Obtiene el email de soporte desde variables de entorno
   */
  private static getSupportEmail(): string {
    return process.env.UNCODIE_SUPPORT_EMAIL || 'support@makinari.com';
  }
  
  /**
   * Obtiene el nombre de la compañía desde variables de entorno
   */
  private static getCompanyName(): string {
    return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
  }
  
  /**
   * Notifica al visitante que su mensaje fue recibido y será atendido
   */
  static async notifyMessageReceived(params: NotifyVisitorParams): Promise<NotifyVisitorResult> {
    try {
      console.log(`📧 Enviando confirmación de mensaje recibido a: ${params.visitorEmail}`);

      const locale = await resolveEmailLocale({ siteId: params.siteId });
      const html = this.generateMessageReceivedHtml(params, locale);
      
      const result = await sendGridService.sendEmail({
        to: params.visitorEmail,
        subject: platformT(locale, 'visitor.message_received.subject'),
        html,
        categories: ['visitor-notification', 'message-received', 'transactional'],
        customArgs: {
          notificationType: 'visitor_message_received',
          visitorEmail: params.visitorEmail,
          agentName: params.agentName || 'system',
          locale,
        }
      });
      
      if (result.success) {
        console.log(`✅ Visitante notificado exitosamente: ${params.visitorEmail}`);
      } else {
        console.error(`❌ Error al notificar al visitante ${params.visitorEmail}:`, result.error);
      }
      
      return {
        success: result.success,
        messageId: result.messageId,
        error: result.error
      };
      
    } catch (error) {
      console.error('Error en VisitorNotificationService:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }
  
  /**
   * Genera el HTML para el email de confirmación al visitante
   */
  private static generateMessageReceivedHtml(
    params: NotifyVisitorParams,
    locale: EmailLocale = DEFAULT_EMAIL_LOCALE
  ): string {
    const nameSuffix = params.visitorName ? `, ${params.visitorName}` : '';
    const title = platformT(locale, 'visitor.message_received.title');
    const body = platformT(locale, 'visitor.message_received.body', { nameSuffix });
    const supportEmail = params.supportEmail || this.getSupportEmail();
    const escapedSupportEmail = EmailSendService.escapeHtml(supportEmail);
    const attrSupportEmail = EmailSendService.escapeAttr(supportEmail);
    const companyName = EmailSendService.escapeHtml(this.getCompanyName());
    const brandingText = EmailSendService.escapeHtml(this.getBrandingText());
    
    return `
      <!DOCTYPE html>
      <html lang="${locale}">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${EmailSendService.escapeHtml(title)}</title>
        ${emailBrandHeadTags()}
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: ${EMAIL_BRAND.bodyBg}; line-height: 1.6;">
        <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: ${EMAIL_BRAND.cardBg}; border-radius: 12px; overflow: hidden;">
          <div class="email-header" style="background: ${EMAIL_BRAND.headerBg}; padding: 32px 40px; text-align: center;">
            <h1 class="email-header-title" style="margin: 0; color: ${EMAIL_BRAND.headerText}; font-size: 24px; font-weight: 600;">${EmailSendService.escapeHtml(title)}</h1>
          </div>
          <div style="padding: 40px;">
            <p class="email-text" style="margin: 0 0 16px; font-size: 16px; color: ${EMAIL_BRAND.text}; line-height: 1.7;">
              ${EmailSendService.escapeHtml(body)}
            </p>
            <div class="email-panel" style="margin-bottom: 32px; background-color: ${EMAIL_BRAND.panelBg}; border-left: 4px solid ${EMAIL_BRAND.accent}; padding: 20px 24px; border-radius: 0 8px 8px 0; border: 1px solid ${EMAIL_BRAND.panelBorder};">
              <p class="email-text" style="margin: 0; font-size: 16px; color: ${EMAIL_BRAND.text}; font-style: italic; line-height: 1.7;">
                "${EmailSendService.escapeHtml(params.message)}"
              </p>
            </div>
            <div style="margin-bottom: 16px;">
              <a class="email-link" href="mailto:${attrSupportEmail}" style="color: ${EMAIL_BRAND.link}; font-weight: 600; text-decoration: none; font-size: 15px;">
                ${escapedSupportEmail}
              </a>
            </div>
            <p class="email-muted" style="margin: 0; color: ${EMAIL_BRAND.muted}; font-size: 14px;">
              ${companyName}
            </p>
          </div>
        </div>
        <div style="text-align: center; margin: 24px 0;">
          <p class="email-subtle" style="margin: 0; color: ${EMAIL_BRAND.subtle}; font-size: 12px;">
            ${brandingText}
          </p>
        </div>
      </body>
      </html>
    `;
  }
}

export default VisitorNotificationService; 