import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationType, NotificationPriority, NotificationService } from '@/lib/services/notification-service';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { TeamNotificationService } from '@/lib/services/team-notification-service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, site_id, team_member_email, instance_id, message, title } = body;

    // Handle "list" action
    if (action === 'list') {
      if (!site_id) {
        return NextResponse.json(
          { success: false, error: 'site_id is required for listing team members' },
          { status: 400 }
        );
      }

      const teamMembers = await TeamNotificationService.getTeamMembersWithEmailNotifications(site_id);
      return NextResponse.json({
        success: true,
        data: teamMembers
      });
    }

    // Handle "notify" action (default)
    if (!site_id || !team_member_email || !message || !title) {
      return NextResponse.json(
        { success: false, error: 'site_id, team_member_email, message, and title are required for sending notifications' },
        { status: 400 }
      );
    }

    // Find the user by email using profiles table first
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', team_member_email)
      .single();
      
    let user_id = profile?.id;
    let phone = null;

    if (user_id) {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(user_id);
      if (userData?.user) {
        phone = userData.user.phone || userData.user.user_metadata?.phone;
      }
    }

    let whatsappSent = false;
    let emailSent = false;
    let notificationSent = false;

    // The template should link to the instance_id
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const isUuid = (str?: string) => str && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
    const validInstanceId = isUuid(instance_id) ? instance_id : undefined;

    const instanceUrl = validInstanceId 
      ? `${baseUrl}/sites/${site_id}/instances/${validInstanceId}`
      : `${baseUrl}/sites/${site_id}`;

    // Send WhatsApp if phone exists
    if (phone) {
      const waMessage = `*${title}*\n\n${message}\n\nVer más detalles: ${instanceUrl}`;
      const waResult = await WhatsAppSendService.sendMessage({
        phone_number: phone,
        message: waMessage,
        from: 'Gear',
        site_id
      });
      whatsappSent = waResult.success;
    }

    // Always create an in-app notification if user exists
    if (user_id) {
      const notificationResult = await NotificationService.createNotification({
        user_id: user_id,
        site_id: site_id,
        title: title,
        message: message,
        type: NotificationType.INFO,
        priority: NotificationPriority.NORMAL,
        related_entity_type: validInstanceId ? 'instance' : undefined,
        related_entity_id: validInstanceId
      });
      
      if (notificationResult) {
        notificationSent = true;
      }
    }

    // If no phone or WhatsApp failed, send Email
    if (!whatsappSent) {
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
          <h2 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">${EmailSendService.escapeHtml(title)}</h2>
          <div style="font-size: 16px; line-height: 1.6; margin: 20px 0;">
            ${EmailSendService.renderMessageWithLists(message)}
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${EmailSendService.escapeAttr(instanceUrl)}" 
               style="display: inline-block; background-color: #6366f1; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">
              Ver Instancia
            </a>
          </div>
        </div>
      `;

      const emailResult = await sendGridService.sendEmail({
        to: team_member_email,
        subject: title,
        html: htmlContent,
        categories: ['system-notification']
      });
      emailSent = emailResult.success;
    }

    return NextResponse.json({
      success: true,
      data: {
        whatsapp_sent: whatsappSent,
        email_sent: emailSent,
        notification_sent: notificationSent,
        user_id: user_id,
        instance_url: instanceUrl
      }
    });

  } catch (error: any) {
    console.error('Error in system_notification tool:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
