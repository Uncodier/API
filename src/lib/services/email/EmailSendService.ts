import * as nodemailer from 'nodemailer';
import { EmailConfigService } from './EmailConfigService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

export interface SendEmailParams {
  email: string;
  from: string; // Nombre del remitente (opcional)
  fromEmail?: string; // Email del remitente desde configuración del sitio
  subject: string;
  message: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  site_id: string;
}

export interface SendEmailResult {
  success: boolean;
  email_id?: string;
  recipient?: string;
  sender?: string;
  subject?: string;
  message_preview?: string;
  sent_at?: string;
  status?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
  };
}

interface SiteInfo {
  name: string;
  url?: string;
}

export class EmailSendService {
  /**
   * Envía un email usando la configuración SMTP del sitio
   */
  static async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const { email, from, fromEmail, subject, message, agent_id, conversation_id, lead_id, site_id } = params;
    
    // Si el email es el temporal, no enviar email real
    if (email === 'no-email@example.com') {
      console.log('📧 Email temporal detectado, no se enviará email real:', {
        to: email,
        from: from || 'AI Assistant',
        fromEmail: fromEmail,
        subject,
        messagePreview: message.substring(0, 100) + '...'
      });
      
      return {
        success: true,
        email_id: uuidv4(),
        recipient: email,
        sender: fromEmail || from,
        subject,
        message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        sent_at: new Date().toISOString(),
        status: 'skipped',
        reason: 'Temporary email address - no real email sent'
      };
    }

    try {
      // Obtener información del sitio
      const siteInfo = await this.getSiteInfo(site_id);
      
      // Obtener configuración de email para el sitio
      const emailConfig = await EmailConfigService.getEmailConfig(site_id);
      
      // Usar el email configurado del sitio o el del parámetro fromEmail
      const senderEmail = fromEmail || emailConfig.user || emailConfig.email;
      
      if (!senderEmail) {
        throw new Error('No se pudo determinar el email del remitente');
      }
      
      // Crear transporter con la configuración SMTP del sitio
      const transporter = nodemailer.createTransport({
        host: emailConfig.smtpHost,
        port: emailConfig.smtpPort,
        secure: emailConfig.smtpPort === 465, // true para puerto 465, false para otros puertos
        auth: {
          user: emailConfig.user || emailConfig.email,
          pass: emailConfig.password,
        },
        tls: {
          rejectUnauthorized: false // Para evitar problemas con certificados auto-firmados
        }
      });

      // Preparar el contenido HTML del email
      const htmlContent = this.buildHtmlContent(message, siteInfo);

      // Determinar el nombre y email del remitente
      const fromName = from || 'AI Assistant';
      const fromAddress = senderEmail;

      // Configurar opciones del email
      const mailOptions: nodemailer.SendMailOptions = {
        from: `${fromName} <${fromAddress}>`,
        to: email,
        subject,
        html: htmlContent,
        text: message, // Versión de texto plano
        replyTo: fromAddress
      };

      // Enviar el email
      const info = await transporter.sendMail(mailOptions);
      
      console.log('✅ Email enviado exitosamente:', {
        messageId: info.messageId,
        to: email,
        from: `${fromName} <${fromAddress}>`,
        subject
      });

      // Guardar registro del email enviado en la base de datos (opcional)
      await this.saveEmailLog({
        recipient_email: email,
        sender_email: fromAddress,
        subject,
        message_content: message,
        agent_id,
        conversation_id,
        lead_id,
        smtp_message_id: info.messageId
      });
      
      return {
        success: true,
        email_id: info.messageId,
        recipient: email,
        sender: `${fromName} <${fromAddress}>`,
        subject,
        message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        sent_at: new Date().toISOString(),
        status: 'sent'
      };

    } catch (configError) {
      console.error('Error obteniendo configuración de email o enviando email:', configError);
      
      const isConfigError = configError instanceof Error && (
        configError.message.includes('settings') || 
        configError.message.includes('token') ||
        configError.message.includes('Site settings not found') ||
        configError.message.includes('No se encontró token de email')
      );
      
      return {
        success: false,
        error: {
          code: isConfigError ? 'EMAIL_CONFIG_NOT_FOUND' : 'EMAIL_SEND_FAILED',
          message: isConfigError 
            ? `Email configuration not found for site ${site_id}. Please configure email settings and store email token using /api/secure-tokens endpoint.`
            : configError instanceof Error ? configError.message : 'Failed to send email'
        }
      };
    }
  }

  /**
   * Obtiene información del sitio desde la base de datos
   */
  private static async getSiteInfo(siteId: string): Promise<SiteInfo> {
    try {
      const { data: site, error } = await supabaseAdmin
        .from('sites')
        .select('name, url')
        .eq('id', siteId)
        .single();

      if (error || !site) {
        console.warn(`No se pudo obtener información del sitio ${siteId}, usando valores por defecto`);
        return { name: 'Nuestro sitio' };
      }

      return {
        name: site.name || 'Nuestro sitio',
        url: site.url
      };
    } catch (error) {
      console.warn(`Error obteniendo información del sitio ${siteId}:`, error);
      return { name: 'Nuestro sitio' };
    }
  }

  /**
   * Construye el contenido HTML del email
   */
  private static buildHtmlContent(message: string, siteInfo: SiteInfo): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <div style="line-height: 1.6; font-size: 16px;">
          ${message.split('\n').map((line: string) => 
            line.trim() ? `<p style="margin: 0 0 16px 0;">${line}</p>` : '<br>'
          ).join('')}
        </div>
        
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #f0f0f0;">
          <p style="font-size: 14px; color: #666; margin: 0; font-style: italic;">
            ¡Que tengas un excelente día! 😊
          </p>
          ${siteInfo.url ? `
          <p style="font-size: 12px; color: #999; margin: 8px 0 0 0;">
            Enviado desde <a href="${siteInfo.url}" style="color: #007bff; text-decoration: none;">${siteInfo.name}</a>
          </p>
          ` : `
          <p style="font-size: 12px; color: #999; margin: 8px 0 0 0;">
            Enviado desde ${siteInfo.name}
          </p>
          `}
        </div>
      </div>
    `;
  }

  /**
   * Guarda el log del email enviado en la base de datos
   */
  private static async saveEmailLog(logData: {
    recipient_email: string;
    sender_email: string;
    subject: string;
    message_content: string;
    agent_id?: string;
    conversation_id?: string;
    lead_id?: string;
    smtp_message_id: string;
  }): Promise<void> {
    try {
      const emailLogData = {
        id: uuidv4(),
        ...logData,
        agent_id: logData.agent_id || null,
        conversation_id: logData.conversation_id || null,
        lead_id: logData.lead_id || null,
        sent_at: new Date().toISOString(),
        status: 'sent'
      };
      
      // Intentar guardar en tabla de logs de emails (si existe)
      const { error: logError } = await supabaseAdmin
        .from('email_logs')
        .insert([emailLogData]);
      
      if (logError) {
        console.warn('No se pudo guardar el log del email (tabla posiblemente no existe):', logError.message);
      }
    } catch (logError) {
      console.warn('Error al intentar guardar log del email:', logError);
    }
  }

  /**
   * Valida el formato de email
   */
  static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
} 