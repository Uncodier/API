import nodemailer from 'nodemailer';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

/**
 * Tipos de notificaciones soportados por el sistema
 */
export enum NotificationType {
  INFO = 'info',
  SUCCESS = 'success',
  WARNING = 'warning',
  ERROR = 'error',
}

/**
 * Prioridad de las notificaciones
 */
export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Estado de las notificaciones
 */
export enum NotificationStatus {
  UNREAD = 'unread',
  READ = 'read',
  ARCHIVED = 'archived',
}

/**
 * Interfaz para crear una notificación
 */
export interface CreateNotificationParams {
  user_id?: string;
  site_id?: string;
  title: string;
  message: string;
  type: NotificationType;
  priority: NotificationPriority;
  related_entity_type?: string;
  related_entity_id?: string;
}

/**
 * Interfaz para enviar un correo electrónico
 */
export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

/**
 * Servicio de notificaciones para la aplicación
 */
export class NotificationService {
  private static transporter: nodemailer.Transporter | null = null;

  /**
   * Inicializa el transporter de nodemailer
   */
  private static initEmailTransporter(): nodemailer.Transporter {
    if (this.transporter) {
      return this.transporter;
    }

    // Verificar que existan las variables de entorno necesarias
    const host = process.env.EMAIL_HOST;
    const port = process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT, 10) : 587;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;
    const from = process.env.EMAIL_FROM || 'no-reply@uncodie.com';

    if (!host || !user || !pass) {
      throw new Error('SMTP configuration not found in environment variables');
    }

    // Crear el transporter
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    });

    return this.transporter;
  }

  /**
   * Crea una notificación en el sistema
   * 
   * @param params Parámetros de la notificación
   * @returns La notificación creada o null si hubo un error
   */
  static async createNotification(params: CreateNotificationParams): Promise<any | null> {
    try {
      const notificationId = uuidv4();
      
      const notification = {
        id: notificationId,
        title: params.title,
        message: params.message,
        type: params.type,
        user_id: params.user_id,
        site_id: params.site_id,
        related_entity_type: params.related_entity_type,
        related_entity_id: params.related_entity_id,
        is_read: false,
        created_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('notifications')
        .insert([notification])
        .select()
        .single();

      if (error) {
        console.error('Error al crear notificación:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error en createNotification:', error);
      return null;
    }
  }

  /**
   * Envía un correo electrónico
   * 
   * @param params Parámetros del correo
   * @returns true si se envió correctamente, false en caso contrario
   */
  static async sendEmail(params: SendEmailParams): Promise<boolean> {
    try {
      const transporter = this.initEmailTransporter();
      
      const from = params.from || process.env.EMAIL_FROM || 'no-reply@uncodie.com';
      
      // Opciones de envío
      const mailOptions: nodemailer.SendMailOptions = {
        from,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text || '',
        replyTo: params.replyTo,
        attachments: params.attachments,
      };

      // Enviar el correo
      const info = await transporter.sendMail(mailOptions);
      
      console.log('Correo enviado:', info.messageId);
      return true;
    } catch (error) {
      console.error('Error al enviar correo:', error);
      return false;
    }
  }

  /**
   * Envía una notificación y un correo electrónico
   * 
   * @param notificationParams Parámetros de la notificación
   * @param emailParams Parámetros del correo (opcional)
   * @returns Un objeto con los resultados de la notificación y el correo
   */
  static async notify(
    notificationParams: CreateNotificationParams, 
    emailParams?: SendEmailParams
  ): Promise<{ notificationSent: boolean, emailSent: boolean }> {
    let notificationSent = false;
    let emailSent = false;

    // Crear la notificación en el sistema
    const notification = await this.createNotification(notificationParams);
    notificationSent = !!notification;

    // Si se proporcionaron parámetros de correo, enviar el correo
    if (emailParams) {
      emailSent = await this.sendEmail(emailParams);
    }

    return { notificationSent, emailSent };
  }

  /**
   * Marca una notificación como leída
   * 
   * @param notificationId ID de la notificación
   * @returns true si se actualizó correctamente, false en caso contrario
   */
  static async markAsRead(notificationId: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('notifications')
        .update({ 
          is_read: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', notificationId);

      return !error;
    } catch (error) {
      console.error('Error al marcar notificación como leída:', error);
      return false;
    }
  }

  /**
   * Marca una notificación como archivada
   * 
   * @param notificationId ID de la notificación
   * @returns true si se actualizó correctamente, false en caso contrario
   */
  static async archiveNotification(notificationId: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('notifications')
        .update({ 
          is_read: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', notificationId);

      return !error;
    } catch (error) {
      console.error('Error al archivar notificación:', error);
      return false;
    }
  }

  /**
   * Obtiene las notificaciones de un usuario
   * 
   * @param userId ID del usuario
   * @param limit Límite de notificaciones a obtener
   * @param onlyUnread Si solo obtener notificaciones no leídas (opcional)
   * @returns Lista de notificaciones o null si hubo un error
   */
  static async getUserNotifications(
    userId: string, 
    limit: number = 50, 
    onlyUnread?: boolean
  ): Promise<any[] | null> {
    try {
      let query = supabaseAdmin
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (onlyUnread) {
        query = query.eq('is_read', false);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error al obtener notificaciones:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error en getUserNotifications:', error);
      return null;
    }
  }
} 