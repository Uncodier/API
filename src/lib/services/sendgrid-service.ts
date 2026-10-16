import sgMail from '@sendgrid/mail';
import { v4 as uuidv4 } from 'uuid';
import { EmailSendService } from './email/EmailSendService';
import { formatEmailDate, normalizeEmailLocale, type EmailLocale } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { generateHumanInterventionEmailHtml } from '@/lib/emails/human-intervention';
import { EMAIL_BRAND, emailBrandHeadTags, emailCtaButton } from '@/lib/emails/brand';
import { getTransactionalEmailFrom, getTransactionalEmailProvider, type TransactionalEmailProvider } from './email/transactional-email-config';
import { getTransactionalEmailConfigurationDiagnostic, getTransactionalEmailFailureDiagnostic, type TransactionalEmailDiagnostic } from './email/transactional-email-config';

/**
 * Configuración de SendGrid
 */
export interface SendGridConfig {
  apiKey: string;
  defaultFromEmail?: string;
  defaultFromName?: string;
  sandboxMode?: boolean;
}

/**
 * Parámetros para enviar un email
 */
export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: {
    email: string;
    name?: string;
  };
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: Array<{
    content: string; // Base64 encoded
    filename: string;
    type?: string;
    disposition?: 'attachment' | 'inline';
    contentId?: string;
  }>;
  templateId?: string;
  dynamicTemplateData?: Record<string, any>;
  categories?: string[];
  customArgs?: Record<string, string>;
  sendAt?: number; // Unix timestamp for scheduled sending
  /** Stable server-side operation identity for Zavu retries. */
  idempotencyKey?: string;
  /** Shared deadline for trusted callers such as the Supabase Auth hook. */
  signal?: AbortSignal;
}

/**
 * Resultado del envío de email
 */
export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  statusCode?: number;
  provider?: TransactionalEmailProvider;
  status?: string;
  diagnostic?: TransactionalEmailDiagnostic;
  recipientResults?: Array<{
    to: string;
    success: boolean;
    messageId?: string;
    status?: string;
    error?: string;
    diagnostic?: TransactionalEmailDiagnostic;
  }>;
}

/**
 * Transactional email facade. The historical class/export names stay compatible;
 * TRANSACTIONAL_EMAIL_PROVIDER selects the transport for every existing caller.
 */
export class SendGridService {
  private static instance: SendGridService;
  private config: SendGridConfig;
  private initialized: boolean = false;

  private constructor() {
    this.config = {
      apiKey: '',
      defaultFromEmail: process.env.SENDGRID_FROM_EMAIL || 'no-reply@makinari.com',
      defaultFromName: process.env.SENDGRID_FROM_NAME || 'Makinari',
      sandboxMode: false // Siempre enviar emails reales
    };
  }

  /**
   * Obtiene la instancia singleton del servicio
   */
  public static getInstance(): SendGridService {
    if (!SendGridService.instance) {
      SendGridService.instance = new SendGridService();
    }
    return SendGridService.instance;
  }

  /**
   * Inicializa el servicio con la configuración de SendGrid
   */
  public initialize(config?: Partial<SendGridConfig>): void {
    if (getTransactionalEmailProvider() === 'zavu') return;
    if (this.initialized) {
      console.log('🔄 SendGrid service already initialized');
      return;
    }

    const apiKey = config?.apiKey || process.env.SENDGRID_API_KEY;
    
    if (!apiKey) {
      const error = 'SendGrid API key is required. Set SENDGRID_API_KEY environment variable.';
      console.error('❌ SendGrid initialization failed:', error);
      throw new Error(error);
    }

    this.config = {
      ...this.config,
      ...config,
      apiKey
    };

    sgMail.setApiKey(this.config.apiKey);
    this.initialized = true;

    console.log('✅ SendGrid service initialized successfully', {
      fromEmail: this.config.defaultFromEmail,
      fromName: this.config.defaultFromName,
      sandboxMode: this.config.sandboxMode
    });
  }

  /**
   * Verifica si el servicio está inicializado
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }

  /**
   * Envía un email transaccional
   */
  public async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      params.signal?.throwIfAborted();
      if (getTransactionalEmailProvider() === 'zavu') {
        const { sendZavuTransactionalEmail } = await import('./email/ZavuTransactionalEmailService');
        return sendZavuTransactionalEmail(params);
      }
      this.ensureInitialized();

      console.log('📧 Iniciando envío de email...', {
        to: params.to,
        subject: params.subject,
        categories: params.categories,
        sandboxMode: this.config.sandboxMode
      });

      // Preparar el objeto del mensaje
      const msg: any = {
        to: params.to,
        subject: params.subject,
        // SendGrid retains its historical overrides/defaults for a one-variable
        // rollback; the Zavu address need not be verified with SendGrid.
        from: params.from || {
          email: this.config.defaultFromEmail!,
          name: this.config.defaultFromName
        },
        mailSettings: {
          sandboxMode: {
            enable: this.config.sandboxMode
          }
        }
      };

      // Agregar contenido
      if (params.html) {
        msg.html = params.html;
      }
      if (params.text) {
        msg.text = params.text;
      }

      // Campos opcionales
      if (params.replyTo) {
        msg.replyTo = params.replyTo;
      }
      if (params.cc) {
        msg.cc = params.cc;
      }
      if (params.bcc) {
        msg.bcc = params.bcc;
      }
      if (params.attachments) {
        msg.attachments = params.attachments;
      }
      if (params.categories) {
        msg.categories = params.categories;
      }
      if (params.customArgs) {
        msg.customArgs = params.customArgs;
      }
      if (params.sendAt) {
        msg.sendAt = params.sendAt;
      }

      // Template dinámico
      if (params.templateId) {
        msg.templateId = params.templateId;
        if (params.dynamicTemplateData) {
          msg.dynamicTemplateData = params.dynamicTemplateData;
        }
      }

      console.log('📤 Enviando mensaje a SendGrid...', {
        messagePreview: {
          to: msg.to,
          from: msg.from,
          subject: msg.subject,
          sandboxMode: msg.mailSettings.sandboxMode.enable
        }
      });

      // Enviar el email
      params.signal?.throwIfAborted();
      const [response] = await sgMail.send(msg);

      console.log('✅ Email enviado exitosamente', {
        messageId: response.headers['x-message-id'],
        statusCode: response.statusCode,
        sandboxMode: this.config.sandboxMode
      });

      return {
        success: true,
        provider: 'sendgrid',
        messageId: response.headers['x-message-id'] || uuidv4(),
        statusCode: response.statusCode
      };

    } catch (error: any) {
      console.error('❌ Transactional email send failed', {
        statusCode: error.response?.statusCode || 500
      });
      
      let errorMessage = 'Unknown error occurred';
      let statusCode = 500;

      if (error.response) {
        errorMessage = error.response.body?.errors?.[0]?.message || error.message;
        statusCode = error.response.statusCode || 500;
      } else if (error.message) {
        errorMessage = error.message;
      }

      return {
        success: false,
        diagnostic: getTransactionalEmailConfigurationDiagnostic() || getTransactionalEmailFailureDiagnostic(error, 'dispatch'),
        error: errorMessage,
        statusCode
      };
    }
  }

  /**
   * Envía múltiples emails
   */
  public async sendMultipleEmails(emails: SendEmailParams[]): Promise<SendEmailResult[]> {
    const results: SendEmailResult[] = [];
    
    for (const email of emails) {
      const result = await this.sendEmail(email);
      results.push(result);
    }

    return results;
  }

  /**
   * Envía un email usando un template dinámico de SendGrid
   */
  public async sendTemplateEmail(
    templateId: string,
    to: string | string[],
    dynamicTemplateData: Record<string, any>,
    options?: Partial<SendEmailParams>
  ): Promise<SendEmailResult> {
    return this.sendEmail({
      to,
      subject: '', // El template maneja el subject
      templateId,
      dynamicTemplateData,
      ...options
    });
  }

  /**
   * Envía un email de bienvenida
   */
  public async sendWelcomeEmail(
    to: string,
    userData: {
      name: string;
      email: string;
      locale?: string;
      [key: string]: any;
    }
  ): Promise<SendEmailResult> {
    const locale = normalizeEmailLocale(userData.locale);
    const companyName = this.getCompanyName();
    const html = this.generateWelcomeEmailHtml(userData, locale, companyName);
    
    return this.sendEmail({
      to,
      subject: platformT(locale, 'welcome.subject', { companyName, name: userData.name }),
      html,
      categories: ['welcome', 'transactional'],
      customArgs: { locale }
    });
  }

  /**
   * Envía un email de notificación de intervención humana
   */
  public async sendHumanInterventionEmail(
    to: string | string[],
    interventionData: {
      conversationId: string;
      message: string;
      priority: string;
      agentName?: string;
      summary?: string;
      contactName?: string;
      contactEmail?: string;
      conversationUrl: string;
      locale?: string;
    }
  ): Promise<SendEmailResult> {
    const locale = normalizeEmailLocale(interventionData.locale);
    const byAgent = interventionData.agentName ? ` by ${interventionData.agentName}` : '';
    const html = generateHumanInterventionEmailHtml({ ...interventionData, locale });
    
    return this.sendEmail({
      to,
      subject: platformT(locale, 'human_intervention.subject', { byAgent }),
      html,
      categories: ['human-intervention', 'transactional'],
      customArgs: {
        conversationId: interventionData.conversationId,
        priority: interventionData.priority,
        locale,
      }
    });
  }

  /**
   * Envía un email de reseteo de contraseña
   */
  public async sendPasswordResetEmail(
    to: string,
    resetData: {
      name: string;
      resetUrl: string;
      expiresAt: Date;
      locale?: string;
    }
  ): Promise<SendEmailResult> {
    const locale = normalizeEmailLocale(resetData.locale);
    const companyName = this.getCompanyName();
    const expiresAt = formatEmailDate(resetData.expiresAt, locale);
    const html = this.generatePasswordResetEmailHtml(resetData, locale, companyName, expiresAt);
    
    return this.sendEmail({
      to,
      subject: platformT(locale, 'password_reset.subject', { companyName }),
      html,
      categories: ['password-reset', 'transactional'],
      customArgs: { locale }
    });
  }

  private generateWelcomeEmailHtml(
    userData: { name: string; email: string },
    locale: EmailLocale,
    companyNameRaw: string
  ): string {
    const escapedEmail = EmailSendService.escapeHtml(userData.email);
    const companyName = EmailSendService.escapeHtml(companyNameRaw);
    const title = EmailSendService.escapeHtml(platformT(locale, 'welcome.title', { companyName: companyNameRaw }));
    const body = EmailSendService.escapeHtml(
      platformT(locale, 'welcome.body', { companyName: companyNameRaw, email: userData.email })
    );
    const cta = EmailSendService.escapeHtml(platformT(locale, 'welcome.cta'));
    const hello = EmailSendService.escapeHtml(platformT(locale, 'common.hello', { name: userData.name }));
    
    return `
      <!DOCTYPE html>
      <html lang="${locale}">
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        ${emailBrandHeadTags()}
      </head>
      <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:${EMAIL_BRAND.bodyBg};">
        <div class="email-card" style="max-width:600px;margin:40px auto;background-color:${EMAIL_BRAND.cardBg};border-radius:12px;overflow:hidden;">
          <div class="email-header" style="background:${EMAIL_BRAND.headerBg};padding:28px 32px;text-align:center;">
            <h1 class="email-header-title" style="margin:0;color:${EMAIL_BRAND.headerText};font-size:22px;font-weight:600;">${title}</h1>
          </div>
          <div style="padding:32px;">
            <p class="email-text" style="font-size:16px;margin:0 0 16px;color:${EMAIL_BRAND.text};">${hello}</p>
            <p class="email-text" style="font-size:16px;margin:0 0 16px;color:${EMAIL_BRAND.text};">${body}</p>
            <p class="email-text" style="font-size:16px;margin:0 0 8px;color:${EMAIL_BRAND.text};"><strong>${escapedEmail}</strong> · ${companyName}</p>
            ${emailCtaButton(this.getAppUrl(), cta)}
            <p class="email-muted" style="color:${EMAIL_BRAND.muted};font-size:14px;margin:24px 0 0;text-align:center;">
              ${EmailSendService.escapeHtml(platformT(locale, 'common.support'))}
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Genera HTML para email de intervención humana
   */
  private generatePasswordResetEmailHtml(
    resetData: {
      name: string;
      resetUrl: string;
      expiresAt: Date;
    },
    locale: EmailLocale,
    companyNameRaw: string,
    expiresAtLabel: string
  ): string {
    const title = EmailSendService.escapeHtml(platformT(locale, 'password_reset.title'));
    const body = EmailSendService.escapeHtml(
      platformT(locale, 'password_reset.body', { expiresAt: expiresAtLabel })
    );
    const cta = EmailSendService.escapeHtml(platformT(locale, 'password_reset.cta'));
    const hello = EmailSendService.escapeHtml(platformT(locale, 'common.hello', { name: resetData.name }));
    const companyName = EmailSendService.escapeHtml(companyNameRaw);
    
    return `
      <!DOCTYPE html>
      <html lang="${locale}">
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        ${emailBrandHeadTags()}
      </head>
      <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:${EMAIL_BRAND.bodyBg};">
        <div class="email-card" style="max-width:600px;margin:40px auto;background-color:${EMAIL_BRAND.cardBg};border-radius:12px;overflow:hidden;">
          <div class="email-header" style="background:${EMAIL_BRAND.headerBg};padding:28px 32px;text-align:center;">
            <h1 class="email-header-title" style="margin:0;color:${EMAIL_BRAND.headerText};font-size:22px;font-weight:600;">${title}</h1>
          </div>
          <div style="padding:32px;">
            <p class="email-text" style="font-size:16px;margin:0 0 16px;color:${EMAIL_BRAND.text};">${hello}</p>
            <p class="email-text" style="font-size:16px;margin:0 0 16px;color:${EMAIL_BRAND.text};">${body}</p>
            <p class="email-muted" style="font-size:14px;margin:0;color:${EMAIL_BRAND.muted};">${companyName}</p>
            ${emailCtaButton(resetData.resetUrl, cta)}
            <p class="email-muted" style="color:${EMAIL_BRAND.muted};font-size:14px;margin:24px 0 0;">
              ${EmailSendService.escapeHtml(platformT(locale, 'common.support'))}
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Obtiene la configuración actual del servicio
   */
  public getConfig(): Partial<SendGridConfig> {
    if (getTransactionalEmailProvider() === 'zavu') {
      return {
        defaultFromEmail: getTransactionalEmailFrom(),
        defaultFromName: process.env.TRANSACTIONAL_EMAIL_FROM_NAME?.trim() || 'Makinari',
        sandboxMode: false,
      };
    }
    return {
      defaultFromEmail: this.config.defaultFromEmail,
      defaultFromName: this.config.defaultFromName,
      sandboxMode: this.config.sandboxMode
    };
  }

  /**
   * Verifica la salud del servicio SendGrid
   */
  public async healthCheck(): Promise<boolean> {
    try {
      if (getTransactionalEmailProvider() === 'zavu') {
        const { resolveZavuTransactionalSender } = await import('./email/ZavuTransactionalEmailService');
        await resolveZavuTransactionalSender(AbortSignal.timeout(4_000));
        return true;
      }
      this.ensureInitialized();
      // SendGrid no tiene un endpoint específico de health check,
      // pero podemos verificar que la API key esté configurada
      return !!this.config.apiKey;
    } catch (error) {
      console.error('Transactional email health check failed');
      return false;
    }
  }

  /**
   * Obtiene el nombre de la compañía desde variables de entorno
   */
  private getCompanyName(): string {
    return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
  }

  /**
   * Obtiene la URL de la aplicación desde variables de entorno
   */
  private getAppUrl(): string {
    return process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
  }
}

// Exportar instancia singleton para uso directo
export const sendGridService = SendGridService.getInstance();
export default sendGridService; 