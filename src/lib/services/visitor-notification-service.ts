import { sendGridService } from './sendgrid-service';
import { EmailSendService } from './email/EmailSendService';

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
    return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
  }
  
  /**
   * Obtiene el email de soporte desde variables de entorno
   */
  private static getSupportEmail(): string {
    return process.env.UNCODIE_SUPPORT_EMAIL || 'support@uncodie.com';
  }
  
  /**
   * Obtiene el nombre de la compañía desde variables de entorno
   */
  private static getCompanyName(): string {
    return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
  }
  
  /**
   * Notifica al visitante que su mensaje fue recibido y será atendido
   */
  static async notifyMessageReceived(params: NotifyVisitorParams): Promise<NotifyVisitorResult> {
    try {
      console.log(`📧 Enviando confirmación de mensaje recibido a: ${params.visitorEmail}`);
      
      const html = this.generateMessageReceivedHtml(params);
      
      const result = await sendGridService.sendEmail({
        to: params.visitorEmail,
        subject: `We've received your message - Our team will respond shortly`,
        html,
        categories: ['visitor-notification', 'message-received', 'transactional'],
        customArgs: {
          notificationType: 'visitor_message_received',
          visitorEmail: params.visitorEmail,
          agentName: params.agentName || 'system'
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
  private static generateMessageReceivedHtml(params: NotifyVisitorParams): string {
    const greeting = params.visitorName ? `Hi ${EmailSendService.escapeHtml(params.visitorName)}` : "Hello";
    const agentText = params.agentName ? `our AI assistant ${EmailSendService.escapeHtml(params.agentName)}` : "our AI assistant";
    const supportEmail = params.supportEmail || this.getSupportEmail();
    const escapedSupportEmail = EmailSendService.escapeHtml(supportEmail);
    const attrSupportEmail = EmailSendService.escapeAttr(supportEmail);
    const companyName = EmailSendService.escapeHtml(this.getCompanyName());
    const brandingText = EmailSendService.escapeHtml(this.getBrandingText());
    
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>We've received your message</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
        
        <!-- Main Container -->
        <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
          
          <!-- Header -->
          <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 40px; text-align: center;">
            <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px;">
              <div style="width: 32px; height: 32px; background-color: #ffffff; border-radius: 50%; position: relative; display: flex; align-items: center; justify-content: center;">
                <div style="width: 12px; height: 6px; border: 3px solid #10b981; border-top: none; border-right: none; transform: rotate(-45deg); margin-top: -2px;"></div>
              </div>
            </div>
            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Message Received!</h1>
            <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Our team will respond shortly</p>
          </div>
          
          <!-- Content -->
          <div style="padding: 40px;">
            
            <!-- Greeting -->
            <div style="margin-bottom: 32px;">
              <p style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 500;">
                ${greeting}!
              </p>
              <p style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">
                Thank you for reaching out to us. ${agentText} has escalated your request to our human support team, and they'll get back to you as soon as possible.
              </p>
            </div>
            
            <!-- Message Summary -->
            <div style="margin-bottom: 32px;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Your Message</h3>
              <div style="background-color: #f8fafc; border-left: 4px solid #10b981; padding: 20px 24px; border-radius: 0 8px 8px 0;">
                <p style="margin: 0; font-size: 16px; color: #475569; font-style: italic; line-height: 1.7;">
                  "${EmailSendService.escapeHtml(params.message)}"
                </p>
              </div>
            </div>
            
            ${params.summary ? `
            <!-- Conversation Context -->
            <div style="margin-bottom: 32px;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Conversation Summary</h3>
              <div style="background-color: #f1f5f9; padding: 20px 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <div style="margin: 0; font-size: 15px; color: #475569; line-height: 1.6;">
                  ${EmailSendService.renderMessageWithLists(params.summary)}
                </div>
              </div>
            </div>
            ` : ''}
            
            <!-- What happens next -->
            <div style="margin-bottom: 32px;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">What happens next?</h3>
              <div style="background-color: #ecfdf5; padding: 20px 24px; border-radius: 8px; border: 1px solid #a7f3d0;">
                <div style="margin-bottom: 12px;">
                  <div style="display: flex; align-items: flex-start; margin-bottom: 8px;">
                    <span style="display: inline-block; width: 20px; height: 20px; background-color: #10b981; border-radius: 50%; margin-right: 12px; margin-top: 2px; flex-shrink: 0; text-align: center; line-height: 20px; color: white; font-size: 12px; font-weight: 600;">1</span>
                    <span style="color: #065f46; font-size: 15px; line-height: 1.4;">A human support specialist will review your message promptly</span>
                  </div>
                  <div style="display: flex; align-items: flex-start; margin-bottom: 8px;">
                    <span style="display: inline-block; width: 20px; height: 20px; background-color: #10b981; border-radius: 50%; margin-right: 12px; margin-top: 2px; flex-shrink: 0; text-align: center; line-height: 20px; color: white; font-size: 12px; font-weight: 600;">2</span>
                    <span style="color: #065f46; font-size: 15px; line-height: 1.4;">They'll respond to you personally via email at the earliest opportunity</span>
                  </div>
                  <div style="display: flex; align-items: flex-start;">
                    <span style="display: inline-block; width: 20px; height: 20px; background-color: #10b981; border-radius: 50%; margin-right: 12px; margin-top: 2px; flex-shrink: 0; text-align: center; line-height: 20px; color: white; font-size: 12px; font-weight: 600;">3</span>
                    <span style="color: #065f46; font-size: 15px; line-height: 1.4;">You'll be able to continue the conversation from there</span>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- Contact info -->
            <div style="margin-bottom: 32px;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Need immediate assistance?</h3>
              <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
                <p style="margin: 0 0 12px; color: #1e40af; font-size: 15px; line-height: 1.6;">
                  If your matter is urgent, you can reach us directly at:
                </p>
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Email:</span>
                  <a href="mailto:${attrSupportEmail}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">
                    ${escapedSupportEmail}
                  </a>
                </div>
              </div>
            </div>
            
          </div>
          
          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
              Thank you for choosing ${this.getCompanyName()}!<br>
              This email was sent automatically. Please do not reply to this message.
            </p>
          </div>
          
        </div>
        
        <!-- Powered by -->
        <div style="text-align: center; margin: 24px 0;">
          <p style="margin: 0; color: #94a3b8; font-size: 12px;">
            Powered by <strong style="color: #667eea;">${this.getBrandingText()}</strong>
          </p>
        </div>
        
      </body>
      </html>
    `;
  }
}

export default VisitorNotificationService; 