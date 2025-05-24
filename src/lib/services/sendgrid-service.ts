import sgMail from '@sendgrid/mail';
import { v4 as uuidv4 } from 'uuid';

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
}

/**
 * Resultado del envío de email
 */
export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  statusCode?: number;
}

/**
 * Servicio de SendGrid para notificaciones transaccionales
 */
export class SendGridService {
  private static instance: SendGridService;
  private config: SendGridConfig;
  private initialized: boolean = false;

  private constructor() {
    this.config = {
      apiKey: '',
      defaultFromEmail: process.env.SENDGRID_FROM_EMAIL || 'no-reply@uncodie.com',
      defaultFromName: process.env.SENDGRID_FROM_NAME || 'Uncodie',
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
      sandboxMode: this.config.sandboxMode,
      apiKeyPreview: this.config.apiKey.substring(0, 10) + '...'
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
      const [response] = await sgMail.send(msg);

      console.log('✅ Email enviado exitosamente', {
        messageId: response.headers['x-message-id'],
        statusCode: response.statusCode,
        sandboxMode: this.config.sandboxMode
      });

      return {
        success: true,
        messageId: response.headers['x-message-id'] || uuidv4(),
        statusCode: response.statusCode
      };

    } catch (error: any) {
      console.error('❌ Error sending email with SendGrid:', {
        error: error.message,
        response: error.response ? {
          statusCode: error.response.statusCode,
          body: error.response.body
        } : 'No response data'
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
      [key: string]: any;
    }
  ): Promise<SendEmailResult> {
    const html = this.generateWelcomeEmailHtml(userData);
    
    return this.sendEmail({
      to,
      subject: `¡Bienvenido a ${this.getCompanyName()}, ${userData.name}!`,
      html,
      categories: ['welcome', 'transactional']
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
    }
  ): Promise<SendEmailResult> {
    const html = this.generateHumanInterventionEmailHtml(interventionData);
    
    return this.sendEmail({
      to,
      subject: `Human intervention requested${interventionData.agentName ? ` by ${interventionData.agentName}` : ''}`,
      html,
      categories: ['human-intervention', 'transactional'],
      customArgs: {
        conversationId: interventionData.conversationId,
        priority: interventionData.priority
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
    }
  ): Promise<SendEmailResult> {
    const html = this.generatePasswordResetEmailHtml(resetData);
    
    return this.sendEmail({
      to,
      subject: `Restablecer tu contraseña de ${this.getCompanyName()}`,
      html,
      categories: ['password-reset', 'transactional']
    });
  }

  /**
   * Genera HTML para email de bienvenida
   */
  private generateWelcomeEmailHtml(userData: { name: string; email: string }): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #6366f1; margin: 0;">¡Bienvenido a ${this.getCompanyName()}!</h1>
        </div>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          Hola <strong>${userData.name}</strong>,
        </p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          ¡Gracias por unirte a ${this.getCompanyName()}! Estamos emocionados de tenerte en nuestra plataforma.
        </p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          Tu cuenta ha sido creada exitosamente con el email: <strong>${userData.email}</strong>
        </p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${this.getAppUrl()}" 
             style="display: inline-block; background-color: #6366f1; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">
            Acceder a mi cuenta
          </a>
        </div>
        
        <p style="color: #777; font-size: 14px; margin-top: 40px; text-align: center;">
          Si tienes alguna pregunta, no dudes en contactarnos.
        </p>
      </div>
    `;
  }

  /**
   * Genera HTML para email de intervención humana
   */
  private generateHumanInterventionEmailHtml(interventionData: {
    conversationId: string;
    message: string;
    priority: string;
    agentName?: string;
    summary?: string;
    contactName?: string;
    contactEmail?: string;
    conversationUrl: string;
  }): string {
    const agentText = interventionData.agentName ? `Agent <strong>${interventionData.agentName}</strong>` : "The system";
    const hasContactInfo = interventionData.contactName || interventionData.contactEmail;
    
    // Priority colors and labels
    const priorityConfig = {
      low: { color: '#10b981', bg: '#ecfdf5', label: 'Low' },
      normal: { color: '#3b82f6', bg: '#eff6ff', label: 'Normal' },
      high: { color: '#f59e0b', bg: '#fffbeb', label: 'High' },
      urgent: { color: '#ef4444', bg: '#fef2f2', label: 'Urgent' }
    };
    
    const priority = priorityConfig[interventionData.priority as keyof typeof priorityConfig] || priorityConfig.normal;
    
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Human Intervention Required</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
        
        <!-- Main Container -->
        <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
          
          <!-- Header -->
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 40px; text-align: center;">
            <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
              <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 50%; position: relative;">
                <div style="position: absolute; top: 8px; left: 8px; width: 8px; height: 8px; background-color: #ef4444; border-radius: 50%;"></div>
              </div>
            </div>
            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Human Intervention Required</h1>
            <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">Immediate attention needed for ongoing conversation</p>
          </div>
          
          <!-- Content -->
          <div style="padding: 40px;">
            
            <!-- Priority Badge -->
            <div style="margin-bottom: 32px;">
              <div style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                ${priority.label} Priority
              </div>
            </div>
            
            <!-- Main Message -->
            <div style="margin-bottom: 32px;">
              <p style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 500;">
                ${agentText} has requested human intervention in an ongoing conversation.
              </p>
              
              <!-- Message Quote -->
              <div style="background-color: #f8fafc; border-left: 4px solid #667eea; padding: 20px 24px; border-radius: 0 8px 8px 0; margin: 24px 0;">
                <p style="margin: 0; font-size: 16px; color: #475569; font-style: italic; line-height: 1.7;">
                  "${interventionData.message}"
                </p>
              </div>
            </div>
            
            ${interventionData.summary ? `
            <!-- Conversation Summary -->
            <div style="margin-bottom: 32px;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Conversation Summary</h3>
              <div style="background-color: #f1f5f9; padding: 20px 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <p style="margin: 0; font-size: 15px; color: #475569; line-height: 1.6;">
                  ${interventionData.summary}
                </p>
              </div>
            </div>
            ` : ''}
            
            ${hasContactInfo ? `
            <!-- Contact Information -->
            <div style="margin-bottom: 32px;">
              <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Contact Information</h3>
              <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
                ${interventionData.contactName ? `
                <div style="margin-bottom: 12px;">
                  <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Name:</span>
                  <span style="color: #1e293b; font-size: 15px;">${interventionData.contactName}</span>
                </div>
                ` : ''}
                ${interventionData.contactEmail ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Email:</span>
                  <a href="mailto:${interventionData.contactEmail}" style="color: #3b82f6; text-decoration: none; font-size: 15px; border-bottom: 1px solid transparent; transition: border-color 0.2s;">
                    ${interventionData.contactEmail}
                  </a>
                </div>
                ` : ''}
              </div>
            </div>
            ` : ''}
            
            <!-- Action Button -->
            <div style="text-align: center; margin: 40px 0 32px;">
              <a href="${interventionData.conversationUrl}" 
                 style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s;">
                View Conversation →
              </a>
            </div>
            
            <!-- Conversation ID -->
            <div style="text-align: center; margin-bottom: 24px;">
              <p style="margin: 0; color: #64748b; font-size: 13px; font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;">
                Conversation ID: ${interventionData.conversationId}
              </p>
            </div>
            
          </div>
          
          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
              This email was generated automatically by ${this.getCompanyName()}.<br>
              Please do not reply to this message.
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

  /**
   * Genera HTML para email de reseteo de contraseña
   */
  private generatePasswordResetEmailHtml(resetData: {
    name: string;
    resetUrl: string;
    expiresAt: Date;
  }): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
        <h2 style="color: #333; text-align: center; margin-bottom: 30px;">Restablecer contraseña</h2>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          Hola <strong>${resetData.name}</strong>,
        </p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en ${this.getCompanyName()}.
        </p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetData.resetUrl}" 
             style="display: inline-block; background-color: #dc2626; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">
            Restablecer contraseña
          </a>
        </div>
        
        <p style="font-size: 14px; color: #666; margin: 20px 0;">
          Este enlace expirará el <strong>${resetData.expiresAt.toLocaleString()}</strong>.
        </p>
        
        <p style="font-size: 14px; color: #666; margin: 20px 0;">
          Si no solicitaste este cambio, puedes ignorar este email de forma segura.
        </p>
        
        <p style="color: #777; font-size: 14px; margin-top: 40px;">
          Por seguridad, este enlace solo funcionará una vez.
        </p>
      </div>
    `;
  }

  /**
   * Obtiene la configuración actual del servicio
   */
  public getConfig(): Partial<SendGridConfig> {
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
      this.ensureInitialized();
      // SendGrid no tiene un endpoint específico de health check,
      // pero podemos verificar que la API key esté configurada
      return !!this.config.apiKey;
    } catch (error) {
      console.error('SendGrid health check failed:', error);
      return false;
    }
  }

  /**
   * Obtiene el texto de branding desde variables de entorno
   */
  private getBrandingText(): string {
    return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
  }

  /**
   * Obtiene el nombre de la compañía desde variables de entorno
   */
  private getCompanyName(): string {
    return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
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