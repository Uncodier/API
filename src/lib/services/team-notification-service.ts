import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from './sendgrid-service';
import { NotificationService, NotificationType, NotificationPriority } from './notification-service';
import { EmailSendService } from './email/EmailSendService';

/**
 * Interfaz para los datos del miembro del equipo
 */
export interface TeamMember {
  user_id: string;
  email: string;
  name?: string;
  role: string;
  notifications?: {
    email?: boolean;
    [key: string]: any;
  };
}

/**
 * Parámetros para notificar al equipo
 */
export interface NotifyTeamParams {
  siteId: string;
  title: string;
  message: string;
  htmlContent?: string;
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
  static async getTeamMembersWithEmailNotifications(siteId: string): Promise<TeamMember[]> {
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
      
      // Obtener información de los usuarios de auth.users
      const { data: authUsers, error: authUsersError } = await supabaseAdmin.auth.admin.listUsers();
      
      if (authUsersError) {
        console.error('Error al obtener usuarios de auth:', authUsersError);
        throw new Error(`Error al obtener usuarios: ${authUsersError.message}`);
      }
      
      // Filtrar solo los usuarios que están en el sitio
      const relevantAuthUsers = authUsers.users.filter(user => userIds.includes(user.id));
      
      // Obtener perfiles de estos usuarios para acceder a las notificaciones
      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from('profiles')
        .select('id, email, name, notifications')
        .in('id', userIds);
      
      if (profilesError) {
        console.warn('Error al obtener perfiles, continuando sin datos de perfil:', profilesError);
      }
      
      console.log(`👥 Encontrados ${relevantAuthUsers.length} usuarios relevantes`);
      console.log(`📊 Encontrados ${profiles?.length || 0} perfiles con configuraciones`);
      
      // Combinar la información y filtrar por notificaciones de email habilitadas
      const teamMembers: TeamMember[] = [];
      
      for (const userInfo of totalUniqueUsers) {
        const authUser = relevantAuthUsers.find(user => user.id === userInfo.user_id);
        const profile = profiles?.find(p => p.id === userInfo.user_id);
        
        if (!authUser || !authUser.email) {
          console.warn(`Usuario sin email encontrado: ${userInfo.user_id}`);
          continue;
        }
        
        // Verificar si las notificaciones por email están habilitadas
        const notifications = profile?.notifications || {};
        const emailNotificationsEnabled = notifications.email === true;
        
        // Si no hay configuración de notificaciones, asumir que están habilitadas para owners y admins
        const shouldInclude = emailNotificationsEnabled || 
                             (!profile?.notifications && (userInfo.role === 'admin' || userInfo.role === 'owner'));
        
        if (shouldInclude) {
          teamMembers.push({
            user_id: userInfo.user_id,
            email: authUser.email,
            name: profile?.name || authUser.user_metadata?.name || authUser.email,
            role: userInfo.role,
            notifications: notifications
          });
        } else {
          console.log(`🔇 Usuario ${authUser.email} (${userInfo.role}) tiene notificaciones por email deshabilitadas`);
        }
      }
      
      console.log(`✅ ${teamMembers.length} miembros con notificaciones por email habilitadas`);
      return teamMembers;
      
    } catch (error) {
      console.error('Error al obtener miembros del equipo:', error);
      throw error;
    }
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
      priority = 'normal',
      type = NotificationType.WARNING,
      categories = ['team-notification'],
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
      
      // Obtener miembros del equipo con notificaciones habilitadas
      const teamMembers = await this.getTeamMembersWithEmailNotifications(siteId);
      
      result.totalMembers = teamMembers.length;
      result.membersWithEmailEnabled = teamMembers.length;
      
      if (teamMembers.length === 0) {
        console.warn('No hay miembros con notificaciones por email habilitadas');
        result.success = true; // No es un error, simplemente no hay destinatarios
        return result;
      }
      
      // Convertir prioridad a enum
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
      
      // Crear notificaciones en el sistema para cada miembro
      const notificationPromises = teamMembers.map(member =>
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
      
      // Ejecutar todas las notificaciones
      const notificationResults = await Promise.allSettled(notificationPromises);
      
      // Contar notificaciones exitosas
      result.notificationsSent = notificationResults.filter(
        result => result.status === 'fulfilled' && result.value !== null
      ).length;
      
      // Recopilar errores de notificaciones
      notificationResults.forEach((notifResult, index) => {
        if (notifResult.status === 'rejected') {
          const error = `Error en notificación para ${teamMembers[index].email}: ${notifResult.reason}`;
          console.error(error);
          result.errors?.push(error);
        }
      });
      
      // Enviar emails si hay contenido HTML o se especifica
      if (htmlContent || result.notificationsSent > 0) {
        const emails = teamMembers.map(member => member.email);
        
        console.log(`📧 Enviando email a ${emails.length} direcciones:`, emails);
        console.log(`📝 Contenido HTML: ${htmlContent ? 'Personalizado' : 'Generado automáticamente'}`);
        
        const emailResult = await sendGridService.sendEmail({
          to: emails,
          subject: title,
          html: htmlContent || this.generateDefaultHtmlContent(title, message, siteId),
          categories: categories,
          customArgs: {
            siteId,
            notificationType: type,
            priority,
            ...customArgs
          }
        });
        
        console.log(`📊 Resultado de SendGrid:`, {
          success: emailResult.success,
          messageId: emailResult.messageId,
          statusCode: emailResult.statusCode,
          error: emailResult.error
        });
        
        if (emailResult.success) {
          result.emailsSent = emails.length;
          console.log(`📧 ${emails.length} emails enviados exitosamente`);
        } else {
          const error = `Error al enviar emails: ${emailResult.error}`;
          console.error(error);
          result.errors?.push(error);
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
  private static generateDefaultHtmlContent(title: string, message: string, siteId: string): string {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const siteUrl = `${baseUrl}/sites/${siteId}`;
    
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
        <h2 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">${EmailSendService.escapeHtml(title)}</h2>
        
        <div style="font-size: 16px; line-height: 1.6; margin: 20px 0;">
          ${EmailSendService.renderMessageWithLists(message)}
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${EmailSendService.escapeAttr(siteUrl)}" 
             style="display: inline-block; background-color: #6366f1; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">
            Ir al sitio
          </a>
        </div>
        
        <p style="color: #777; font-size: 14px; margin-top: 40px;">
          Este correo fue generado automáticamente por el sistema de notificaciones de Uncodie.
        </p>
      </div>
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
    
    // Usar el método del servicio SendGrid para generar el HTML
    const htmlContent = await this.generateHumanInterventionHtml({
      conversationId: params.conversationId,
      message: params.message,
      priority: params.priority,
      agentName: params.agentName,
      summary: params.summary,
      contactName: params.contactName,
      contactEmail: params.contactEmail,
      conversationUrl
    });
    
    return this.notifyTeam({
      siteId: params.siteId,
      title,
      message: notificationMessage,
      htmlContent,
      priority: params.priority as any,
      type: NotificationType.WARNING,
      categories: ['human-intervention', 'team-notification'],
      customArgs: {
        conversationId: params.conversationId,
        agentName: params.agentName || 'Sistema'
      },
      relatedEntityType: 'conversation',
      relatedEntityId: params.conversationId
    });
  }
  
  /**
   * Genera HTML específico para intervención humana
   */
  private static async generateHumanInterventionHtml(data: {
    conversationId: string;
    message: string;
    priority: string;
    agentName?: string;
    summary?: string;
    contactName?: string;
    contactEmail?: string;
    conversationUrl: string;
  }): Promise<string> {
    // Reutilizar la lógica del servicio SendGrid para consistencia
    return sendGridService['generateHumanInterventionEmailHtml']?.(data) || 
           this.generateDefaultHtmlContent(
             `Intervención humana solicitada${data.agentName ? ` por ${data.agentName}` : ''}`,
             `Se requiere intervención humana: "${data.message}"`,
             data.conversationId
           );
  }
}

export default TeamNotificationService; 