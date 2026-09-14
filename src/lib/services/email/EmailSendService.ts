import { EmailConfigService } from './EmailConfigService';
import { SentEmailDuplicationService } from './SentEmailDuplicationService';
import nodemailer from 'nodemailer';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmailTrackingService } from '../tracking/EmailTrackingService';

export interface SendEmailParams {
  email: string;
  from: string; // Nombre del remitente (opcional)
  fromEmail?: string; // Email del remitente desde configuración del sitio
  subject: string;
  message: string;
  signatureHtml?: string; // Firma HTML profesional
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  site_id: string;
  trackingId?: string; // 🆕 ID para rastreo de apertura y clics
}

export interface SendEmailResult {
  success: boolean;
  email_id?: string;
  envelope_id?: string; // 🆕 ID basado en envelope para correlación con sync
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
    const { 
      email, 
      from, 
      fromEmail, 
      subject, 
      message, 
      signatureHtml, 
      agent_id, 
      conversation_id, 
      lead_id, 
      site_id,
      trackingId
    } = params;
    
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
        email_id: `temp-${Date.now()}`,
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
      let htmlContent = this.buildHtmlContent(message, siteInfo, signatureHtml);

      // Inyectar rastreo si se proporciona trackingId
      if (params.trackingId) {
        console.log(`[EMAIL_SEND] 🎯 Inyectando rastreo con trackingId: ${params.trackingId}`);
        htmlContent = EmailTrackingService.injectTracking(htmlContent, params.trackingId);
      }

      // Determinar el nombre y email del remitente
      const fromName = from || 'AI Assistant';
      const fromAddress = senderEmail;

      // Configurar opciones del email
      const mailOptions: nodemailer.SendMailOptions = {
        from: `${fromName} <${fromAddress}>`,
        to: email,
        subject,
        html: htmlContent,
        text: message.replace(/<[^>]+>/g, ''), // Asegurar versión de texto plano limpia
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

      // Log del email enviado (se guarda automáticamente en Vercel/Supabase)
      console.log('📧 Email enviado - Detalles:', {
        recipient_email: email,
        sender_email: fromAddress,
        subject,
        message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        agent_id,
        conversation_id,
        lead_id,
        smtp_message_id: info.messageId,
        sent_at: new Date().toISOString()
      });
      
      // 🆕 Generar envelope-based ID para correlación con sync
      const sentAt = new Date().toISOString();
      const envelopeData = {
        to: email,
        from: `${fromName} <${fromAddress}>`,
        subject,
        date: sentAt
      };
      
      const envelopeId = SentEmailDuplicationService.generateEnvelopeBasedId(envelopeData);
      console.log(`[EMAIL_SEND] 🏗️ Envelope ID generado para correlación: "${envelopeId}"`);
      
      return {
        success: true,
        email_id: info.messageId,
        envelope_id: envelopeId || undefined, // Convertir null a undefined
        recipient: email,
        sender: `${fromName} <${fromAddress}>`,
        subject,
        message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        sent_at: sentAt,
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
  private static buildHtmlContent(message: string, siteInfo: SiteInfo, signatureHtml?: string): string {
    const isHtml = /<[a-z][\s\S]*>/i.test(message);
    let htmlContent = isHtml ? message : this.renderMessageWithLists(message);
    
    // Si el contenido ya era HTML, no lo envolvemos en el div predeterminado para evitar romper diseños,
    // a menos que queramos inyectar la firma. Para asegurar que la firma se agregue bien, lo envolvemos.
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <div style="line-height: 1.6; font-size: 16px;">
          ${htmlContent}
        </div>
        ${signatureHtml ? `<div style="margin-top: 20px; font-size: 14px; color: #666;">${signatureHtml}</div>` : ''}
      </div>
    `;
  }

  /**
   * Escapa caracteres HTML especiales para prevenir inyección y preservar texto
   */
  public static escapeHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Escapa caracteres para su uso en atributos HTML (como href, src, etc)
   * Se incluye el escape de '&' para cumplir con el estándar HTML en atributos.
   */
  public static escapeAttr(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Convierte texto plano a HTML con soporte para listas con -, *, • y 1. 2.
   */
  public static renderMessageWithLists(message: string): string {
    const lines = message.split('\n');
    const htmlParts: string[] = [];

    const isBullet = (line: string) => /^\s*(?:[-*•]\s+)/.test(line);
    const isNumbered = (line: string) => /^\s*\d+[\.)]\s+/.test(line);

    // Apply inline markdown before parsing blocks
    const applyInlineMarkdown = (text: string) => {
      let html = this.escapeHtml(text);
      // Images: ![alt](url)
      html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<br/><img src="$2" alt="$1" style="max-width: 100%; border-radius: 8px; margin: 16px 0;" /><br/>');
      // Links: [text](url)
      html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color: #0066cc; text-decoration: underline;">$1</a>');
      // Bold
      html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Italic
      html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
      html = html.replace(/_(.*?)_/g, '<em>$1</em>');
      return html;
    };

    let i = 0;
    while (i < lines.length) {
      const raw = lines[i] ?? '';
      const line = raw.trimEnd();

      // Bloque de lista con viñetas
      if (isBullet(line)) {
        const items: string[] = [];
        while (i < lines.length && isBullet((lines[i] ?? '').trimEnd())) {
          const itemText = (lines[i] ?? '')
            .replace(/^\s*[-*•]\s+/, '')
            .trim();
          items.push(`<li style="margin: 4px 0;">${applyInlineMarkdown(itemText)}</li>`);
          i++;
        }
        htmlParts.push(`<ul style="margin: 0 0 16px 20px; padding-left: 18px; list-style-type: disc;">${items.join('')}</ul>`);
        continue;
      }

      // Bloque de lista numerada
      if (isNumbered(line)) {
        const items: string[] = [];
        while (i < lines.length && isNumbered((lines[i] ?? '').trimEnd())) {
          const itemText = (lines[i] ?? '')
            .replace(/^\s*\d+[\.)]\s+/, '')
            .trim();
          items.push(`<li style="margin: 4px 0;">${applyInlineMarkdown(itemText)}</li>`);
          i++;
        }
        htmlParts.push(`<ol style="margin: 0 0 16px 20px; padding-left: 18px; list-style-type: decimal;">${items.join('')}</ol>`);
        continue;
      }

      // Línea vacía -> salto visual
      if (line.trim().length === 0) {
        htmlParts.push('<br>');
        i++;
        continue;
      }

      // Párrafo normal
      htmlParts.push(`<p style="margin: 0 0 16px 0;">${applyInlineMarkdown(line.trim())}</p>`);
      i++;
    }

    return htmlParts.join('');
  }
  /**
   * Valida el formato de email
   */
  static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
} 