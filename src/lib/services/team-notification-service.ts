import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from './sendgrid-service';
import { NotificationService, NotificationType, NotificationPriority, NotificationCategory } from './notification-service';
import { shouldDeliverSiteNotification } from './site-notification-policy';
import { EmailSendService } from './email/EmailSendService';
import {
  type EmailLocale,
  DEFAULT_EMAIL_LOCALE,
  resolveEmailLocale,
  tryNormalizeEmailLocale,
} from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { EMAIL_BRAND, emailBrandHeadTags, emailCtaButton } from '@/lib/emails/brand';

/**
 * Interfaz para los datos del miembro del equipo
 */
export interface TeamMember {
  user_id: string;
  email: string;
  name?: string;
  role: string;
  language?: string | null;
  emailEnabled?: boolean;
  pushEnabled?: boolean;
  notifications?: {
    email?: boolean;
    [key: string]: any;
  };
}

export type BuildTeamEmailFn = (locale: EmailLocale, members: TeamMember[]) => {
  subject: string;
  html: string;
};

/**
 * Parámetros para notificar al equipo
 */
export interface NotifyTeamParams {
  siteId: string;
  title: string;
  message: string;
  htmlContent?: string;
  /** When set, emails are rendered per recipient locale group */
  buildEmail?: BuildTeamEmailFn;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  type?: NotificationType;
  categories?: string[];
  customArgs?: Record<string, string>;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/**
 * Resultado de la notificación al equipo
 */
export interface NotifyTeamResult {
  success: boolean;
  notificationsSent: number;
  emailsSent: number;
  totalMembers: number;
  membersWithEmailEnabled: number;
  errors?: string[];
}

/**
 * Servicio para notificar a todos los miembros del equipo del sitio
 */
export class TeamNotificationService {
  
  /**
   * Obtiene todos los miembros del equipo de un sitio con notificaciones habilitadas
   */
  static async getEligibleTeamMembers(siteId: string, categories?: string[]): Promise<TeamMember[]> {
    try {
      console.log(`🔍 Obteniendo miembros del equipo para el sitio: ${siteId}`);
      
      // Obtener propietarios del sitio (site_ownership)
      const { data: siteOwners, error: siteOwnersError } = await supabaseAdmin
        .from('site_ownership')
        .select('user_id')
        .eq('site_id', siteId);
      
      if (siteOwnersError) {
        console.error('Error al obtener site_owners:', siteOwnersError);
        throw new Error(`Error al obtener propietarios del sitio: ${siteOwnersError.message}`);
      }
      
      // Obtener miembros del sitio (site_members)
      const { data: siteMembers, error: siteMembersError } = await supabaseAdmin
        .from('site_members')
        .select('user_id, role')
        .eq('site_id', siteId);
      
      if (siteMembersError) {
        console.error('Error al obtener site_members:', siteMembersError);
        throw new Error(`Error al obtener miembros del sitio: ${siteMembersError.message}`);
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
        console.log(`🔑 Encontrados ${siteOwners.length} propietarios en site_ownership`);
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
        console.log(`👥 Encontrados ${siteMembers.length} miembros en site_members`);
      }
      
      const totalUniqueUsers = Array.from(allUsers.values());
      
      if (totalUniqueUsers.length === 0) {
        console.warn(`No se encontraron miembros ni propietarios para el sitio: ${siteId}`);
        return [];
      }
      
      console.log(`📋 Total de usuarios únicos: ${totalUniqueUsers.length} (${siteOwners?.length || 0} propietarios + ${siteMembers?.length || 0} miembros)`);
      
      // Obtener los IDs de usuario únicos
      const userIds = Array.from(allUsers.keys());
      
      // Obtener información de los usuarios usando getUserById para evitar límite de 50 usuarios
      const authUsers = { users: [] as any[] };
      for (const id of userIds) {
        const { data: userAuth, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(id);
        if (userAuth?.user && !authUserError) {
          authUsers.users.push(userAuth.user);
        }
      }
      
      const authUsersError: any = null;
      
      if (authUsersError) {
        console.error('Error al obtener usuarios de auth:', authUsersError);
        throw new Error(`Error al obtener usuarios: ${authUsersError.message}`);
      }
      
      // Filtrar solo los usuarios que están en el sitio
      const relevantAuthUsers = authUsers.users.filter(user => userIds.includes(user.id));
      
      // Obtener perfiles de estos usuarios para acceder a las notificaciones
      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from('profiles')
        .select('id, email, name, notifications, language')
        .in('id', userIds);
      
      if (profilesError) {
        console.warn('Error al obtener perfiles, continuando sin datos de perfil:', profilesError);
      }

      // Obtener configuraciones de notificaciones por sitio
      const { data: siteNotifications, error: siteNotifError } = await supabaseAdmin
        .from('user_site_notifications')
        .select('user_id, email_enabled, push_enabled, categories')
        .eq('site_id', siteId)
        .in('user_id', userIds);
      
      if (siteNotifError) {
        console.warn('Error al obtener user_site_notifications:', siteNotifError);
      }

      
      console.log(`👥 Encontrados ${relevantAuthUsers.length} usuarios relevantes`);
      console.log(`📊 Encontrados ${profiles?.length || 0} perfiles con configuraciones`);
      
      const teamMembers: TeamMember[] = [];
      
      for (const userInfo of totalUniqueUsers) {
        const authUser = relevantAuthUsers.find(user => user.id === userInfo.user_id);
        const profile = profiles?.find(p => p.id === userInfo.user_id);
        const siteNotif = siteNotifications?.find(n => n.user_id === userInfo.user_id) ?? null;
        
        if (!authUser || !authUser.email) {
          console.warn(`Usuario sin email encontrado: ${userInfo.user_id}`);
          continue;
        }

        const sitePreferences = siteNotif
          ? {
              email_enabled: siteNotif.email_enabled,
              push_enabled: siteNotif.push_enabled,
              categories: (siteNotif.categories as Record<string, boolean>) || {},
            }
          : null
        const profileNotifications = (profile?.notifications as { email?: boolean; push?: boolean } | null) ?? null

        const emailEnabled = shouldDeliverSiteNotification({
          sitePreferences,
          profileNotifications,
          role: userInfo.role,
          channel: 'email',
          notificationCategories: categories,
        })
        const pushEnabled = shouldDeliverSiteNotification({
          sitePreferences,
          profileNotifications,
          role: userInfo.role,
          channel: 'push',
          notificationCategories: categories,
        })

        if (!emailEnabled && !pushEnabled) {
          console.log(`🔇 Usuario ${authUser.email} (${userInfo.role}) tiene notificaciones deshabilitadas para este sitio/categoría`);
          continue
        }

        teamMembers.push({
          user_id: userInfo.user_id,
          email: authUser.email,
          name: profile?.name || authUser.user_metadata?.name || authUser.email,
          role: userInfo.role,
          language: profile?.language ?? null,
          emailEnabled,
          pushEnabled,
          notifications: profileNotifications || {}
        });
      }
      
      console.log(`✅ ${teamMembers.length} miembros con notificaciones habilitadas`);
      return teamMembers;
      
    } catch (error) {
      console.error('Error al obtener miembros del equipo:', error);
      throw error;
    }
  }

  static async getTeamMembersWithEmailNotifications(siteId: string, categories?: string[]): Promise<TeamMember[]> {
    const members = await this.getEligibleTeamMembers(siteId, categories);
    return members.filter(member => member.emailEnabled !== false);
  }
  
  /**
   * Notifica a todo el equipo del sitio
   */
  static async notifyTeam(params: NotifyTeamParams): Promise<NotifyTeamResult> {
    const {
      siteId,
      title,
      message,
      htmlContent,
      buildEmail,
      priority = 'normal',
      type = NotificationType.WARNING,
      categories = [],
      customArgs = {},
      relatedEntityType,
      relatedEntityId,
    } = params;
    
    const result: NotifyTeamResult = {
      success: false,
      notificationsSent: 0,
      emailsSent: 0,
      totalMembers: 0,
      membersWithEmailEnabled: 0,
      errors: []
    };
    
    try {
      console.log(`📢 Iniciando notificación al equipo del sitio: ${siteId}`);
      
      const teamMembers = await this.getEligibleTeamMembers(siteId, categories);
      const emailRecipients = teamMembers.filter(member => member.emailEnabled !== false);
      const pushRecipients = teamMembers.filter(member => member.pushEnabled !== false);
      
      result.totalMembers = teamMembers.length;
      result.membersWithEmailEnabled = emailRecipients.length;
      
      if (teamMembers.length === 0) {
        console.warn('No hay miembros con notificaciones habilitadas');
        result.success = true;
        return result;
      }
      
      let notificationPriority: NotificationPriority;
      switch (priority) {
        case 'high':
          notificationPriority = NotificationPriority.HIGH;
          break;
        case 'urgent':
          notificationPriority = NotificationPriority.URGENT;
          break;
        case 'low':
          notificationPriority = NotificationPriority.LOW;
          break;
        default:
          notificationPriority = NotificationPriority.NORMAL;
      }
      
      const notificationPromises = pushRecipients.map(member =>
        NotificationService.createNotification({
          user_id: member.user_id,
          site_id: siteId,
          title,
          message,
          type,
          priority: notificationPriority,
          related_entity_type: relatedEntityType,
          related_entity_id: relatedEntityId
        })
      );
      
      const notificationResults = await Promise.allSettled(notificationPromises);
      
      result.notificationsSent = notificationResults.filter(
        r => r.status === 'fulfilled' && r.value !== null
      ).length;
      
      notificationResults.forEach((notifResult, index) => {
        if (notifResult.status === 'rejected') {
          const error = `Error en notificación para ${pushRecipients[index].email}: ${notifResult.reason}`;
          console.error(error);
          result.errors?.push(error);
        }
      });
      
      if (emailRecipients.length > 0) {
        const siteLocale = await resolveEmailLocale({ siteId });
        const groups = new Map<EmailLocale, TeamMember[]>();

        for (const member of emailRecipients) {
          const memberLocale =
            tryNormalizeEmailLocale(member.language) ?? siteLocale ?? DEFAULT_EMAIL_LOCALE;
          const list = groups.get(memberLocale) || [];
          list.push(member);
          groups.set(memberLocale, list);
        }

        for (const [locale, members] of Array.from(groups.entries())) {
          const emails = members.map(m => m.email);
          let subject = title;
          let html = htmlContent || this.generateDefaultHtmlContent(title, message, siteId, locale);

          if (buildEmail) {
            const built = buildEmail(locale, members);
            subject = built.subject;
            html = built.html;
          }

          console.log(`📧 Sending team email (${locale}) to ${emails.length} recipients`);

          const emailResult = await sendGridService.sendEmail({
            to: emails,
            subject,
            html,
            categories,
            customArgs: {
              siteId,
              notificationType: type,
              priority,
              locale,
              ...customArgs
            }
          });

          if (emailResult.success) {
            result.emailsSent += emails.length;
          } else {
            const error = `Error sending emails (${locale}): ${emailResult.error}`;
            console.error(error);
            result.errors?.push(error);
          }
        }
      }
      
      result.success = result.notificationsSent > 0 || result.emailsSent > 0;
      
      console.log(`✅ Notificación completada: ${result.notificationsSent} notificaciones, ${result.emailsSent} emails`);
      
      return result;
      
    } catch (error) {
      console.error('Error al notificar al equipo:', error);
      result.errors?.push(`Error general: ${error instanceof Error ? error.message : 'Error desconocido'}`);
      return result;
    }
  }
  
  /**
   * Genera contenido HTML por defecto para las notificaciones
   */
  private static generateDefaultHtmlContent(
    title: string,
    message: string,
    siteId: string,
    locale: EmailLocale = DEFAULT_EMAIL_LOCALE
  ): string {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const siteUrl = `${baseUrl}/sites/${siteId}`;
    const goToSite =
      locale === 'es' ? 'Ir al sitio' :
      locale === 'fr' ? 'Aller au site' :
      locale === 'de' ? 'Zur Website' :
      locale === 'ja' ? 'サイトを開く' :
      'Go to site';
    const autoGen =
      locale === 'es' ? 'Este correo fue generado automáticamente por el sistema de notificaciones.' :
      locale === 'fr' ? 'Cet e-mail a été généré automatiquement par le système de notifications.' :
      locale === 'de' ? 'Diese E-Mail wurde automatisch vom Benachrichtigungssystem erstellt.' :
      locale === 'ja' ? 'このメールは通知システムにより自動送信されました。' :
      'This email was generated automatically by the notification system.';
    
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
            <h1 class="email-header-title" style="margin:0;color:${EMAIL_BRAND.headerText};font-size:22px;font-weight:600;">${EmailSendService.escapeHtml(title)}</h1>
          </div>
          <div style="padding:32px;">
            <div class="email-text" style="font-size:16px;line-height:1.6;margin:0 0 8px;color:${EMAIL_BRAND.text};">
              ${EmailSendService.renderMessageWithLists(message)}
            </div>
            ${emailCtaButton(siteUrl, goToSite)}
            <p class="email-muted" style="color:${EMAIL_BRAND.muted};font-size:14px;margin:24px 0 0;">
              ${EmailSendService.escapeHtml(autoGen)}
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
  
  /**
   * Notifica específicamente sobre intervención humana usando el nuevo servicio
   */
  static async notifyHumanIntervention(params: {
    siteId: string;
    conversationId: string;
    message: string;
    priority: string;
    agentName?: string;
    summary?: string;
    contactName?: string;
    contactEmail?: string;
  }): Promise<NotifyTeamResult> {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const conversationUrl = `${baseUrl}/chat?conversationId=${params.conversationId}`;
    
    const title = `Human intervention requested${params.agentName ? ` by ${params.agentName}` : ''}`;
    const notificationMessage = `Human intervention is required in a conversation. Message: "${params.message}"`;
    
    return this.notifyTeam({
      siteId: params.siteId,
      title,
      message: notificationMessage,
      buildEmail: (locale) => {
        const byAgent = params.agentName ? ` by ${params.agentName}` : '';
        const subject = platformT(locale, 'human_intervention.subject', { byAgent });
        return {
          subject,
          html: this.generateDefaultHtmlContent(subject, notificationMessage, params.siteId, locale)
            .replace(EmailSendService.escapeAttr(`${baseUrl}/sites/${params.siteId}`), EmailSendService.escapeAttr(conversationUrl)),
        };
      },
      priority: params.priority as any,
      type: NotificationType.WARNING,
      categories: [NotificationCategory.HUMAN_INTERVENTION],
      customArgs: {
        conversationId: params.conversationId,
        agentName: params.agentName || 'Sistema'
      },
      relatedEntityType: 'conversation',
      relatedEntityId: params.conversationId
    });
  }
}

export default TeamNotificationService; 
