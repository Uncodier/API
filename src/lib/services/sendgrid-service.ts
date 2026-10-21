import sgMail from '@sendgrid/mail';
import { v4 as uuidv4 } from 'uuid';
import { EmailSendService } from './email/EmailSendService';
import { formatEmailDate, normalizeEmailLocale, type EmailLocale } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { generateHumanInterventionEmailHtml } from '@/lib/emails/human-intervention';
import { EMAIL_BRAND, emailBrandHeadTags, emailCtaButton } from '@/lib/emails/brand';
import { getTransactionalEmailFrom, getTransactionalEmailProvider, type TransactionalEmailProvider } from './email/transactional-email-config';
import { getTransactionalEmailConfigurationDiagnostic, getTransactionalEmailFailureDiagnostic, type TransactionalEmailDiagnostic } from './email/transactional-email-config';
import { recordTelemetry } from '@/lib/status/telemetry';
import type { SystemHealthStatus } from '@/lib/status/types';

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

const acceptedEmailStates = new Set(['queued', 'sending', 'sent', 'delivered', 'read']);

// Observation only: never change recipient validation or the dispatch contract.
function observationRecipients(to: SendEmailParams['to']): string[] {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length || recipients.some(recipient => typeof recipient !== 'string'
    || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(recipient.trim()))) return [];
  return [...new Set(recipients.map(recipient => recipient.trim().toLowerCase()))];
}

function providerFailureObservation(httpStatus: unknown): SystemHealthStatus {
  // Do not infer an upstream 500 from a local exception or a facade's fallback.
  return typeof httpStatus === 'number' && Number.isInteger(httpStatus)
    && (httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599))
    ? 'down' : 'degraded';
}

function isCallerCancellation(signal?: AbortSignal, error?: unknown): boolean {
  return (signal?.aborted === true && signal.reason?.name !== 'TimeoutError')
    || (error as { name?: unknown } | undefined)?.name === 'AbortError';
}

function zavuAcceptanceObservation(result: SendEmailResult, recipients: string[], signal?: AbortSignal): SystemHealthStatus {
  if (!recipients.length) return 'skipped';
  const results = Array.isArray(result.recipientResults) ? result.recipientResults : [];
  const accepted = recipients.filter(to => results.some(recipient => recipient?.success === true
    && typeof recipient.to === 'string' && recipient.to.trim().toLowerCase() === to
    && typeof recipient.messageId === 'string' && recipient.messageId.length > 0
    && acceptedEmailStates.has(recipient.status || ''))).length;
  const acceptedStatus = typeof result.statusCode === 'number' && Number.isInteger(result.statusCode)
    && result.statusCode >= 200 && result.statusCode < 300;
  if (result.success === true && acceptedStatus && accepted === recipients.length) return 'up';
  if (accepted > 0) return 'degraded';
  if (isCallerCancellation(signal)) return 'skipped';

  const diagnostics = [result.diagnostic, ...results.map(recipient => recipient?.diagnostic)].filter(
    (diagnostic): diagnostic is TransactionalEmailDiagnostic => !!diagnostic);
  // Zavu's failure statusCode is a synthetic 502, including local preflight
  // failures. Only a diagnostic HTTP status from a provider attempt is evidence.
  if (diagnostics.some(diagnostic => ['dispatch', 'sender_verification'].includes(diagnostic.stage)
    && providerFailureObservation(diagnostic.httpStatus) === 'down')) return 'down';
  if (diagnostics.some(diagnostic => ['configuration', 'validation'].includes(diagnostic.stage)
    || ['connection_mismatch', 'sender_not_verified'].includes(diagnostic.code))) return 'skipped';
  return 'degraded';
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
    const start = Date.now();
    let observation: SystemHealthStatus = 'skipped';
    let providerInvoked = false;
    let sandbox = false;
    const recipients = observationRecipients(params.to);
    try {
      params.signal?.throwIfAborted();
      if (getTransactionalEmailProvider() === 'zavu') {
        const { sendZavuTransactionalEmail } = await import('./email/ZavuTransactionalEmailService');
        providerInvoked = true;
        const result = await sendZavuTransactionalEmail(params);
        observation = zavuAcceptanceObservation(result, recipients, params.signal);
        return result;
      }
      this.ensureInitialized();
      sandbox = this.config.sandboxMode === true;

      console.log('📧 Iniciando envío de email...', {
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
        sandboxMode: msg.mailSettings.sandboxMode.enable
      });

      // Enviar el email
      params.signal?.throwIfAborted();
      providerInvoked = true;
      const [response] = await sgMail.send(msg);

      console.log('✅ Email enviado exitosamente', {
        statusCode: response.statusCode,
        sandboxMode: this.config.sandboxMode
      });

      const result: SendEmailResult = {
        success: true,
        provider: 'sendgrid',
        messageId: response.headers['x-message-id'] || uuidv4(),
        statusCode: response.statusCode
      };
      // Keep the historical return, even for a malformed/non-2xx SDK response;
      // only confirmed real acceptance is allowed to report healthy evidence.
      if (!sandbox && recipients.length) {
        observation = typeof response.statusCode === 'number' && Number.isInteger(response.statusCode)
          && response.statusCode >= 200 && response.statusCode < 300
          ? 'up' : providerFailureObservation(response.statusCode);
      }
      return result;

    } catch (error: any) {
      if (providerInvoked && !sandbox && recipients.length && !isCallerCancellation(params.signal, error)) {
        observation = providerFailureObservation(error?.status ?? error?.response?.statusCode);
      }
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
    } finally {
      // This facade covers ALL platform transactional email, not just messages
      // with a notification category. Observe the existing send, never probe or
      // resend. Match central wrappers' generic receipts for sampling/dedup;
      // provider acceptance does not establish mailbox delivery.
      if (observation !== 'skipped') {
        try {
          await recordTelemetry('notifications_email', observation,
            observation === 'up' ? 'Notification email accepted by provider; mailbox delivery unconfirmed'
              : observation === 'degraded' ? 'Notification email partially accepted by provider; mailbox delivery unconfirmed'
                : 'Notification email acceptance failed or unconfirmed', Date.now() - start);
        } catch { /* Best effort; never log recipients, payloads, credentials or provider errors. */ }
      }
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