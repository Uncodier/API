import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationType, NotificationPriority, NotificationService, NotificationCategory } from '@/lib/services/notification-service';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { EMAIL_BRAND, emailBrandHeadTags, emailCtaButton } from '@/lib/emails/brand';

export async function listSystemNotificationCore(site_id: string) {
  if (!site_id) {
    throw new Error('site_id is required for listing team members');
  }
  const teamMembers = await TeamNotificationService.getTeamMembersWithEmailNotifications(
    site_id,
    [NotificationCategory.SYSTEM_ALERTS]
  );
  return teamMembers;
}

import { getRedisClient } from '@/lib/utils/redis-client';

export async function notifySystemNotificationCore(params: {
  site_id: string;
  team_member_email: string;
  instance_id?: string;
  message: string;
  title: string;
  channels?: string[];
  phone_number?: string;
}) {
  const { site_id, team_member_email, instance_id, message, title, channels, phone_number } = params;

  if (!site_id || !team_member_email || !message || !title) {
    throw new Error('site_id, team_member_email, message, and title are required for sending notifications');
  }

  // --- RATE LIMITING LOGIC ---
  const validInstanceIdForRateLimit = instance_id && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(instance_id) ? instance_id : null;
  const rateLimitKey = validInstanceIdForRateLimit 
    ? `rate_limit:sys_notif:${validInstanceIdForRateLimit}:${team_member_email}`
    : `rate_limit:sys_notif:site_${site_id}:${team_member_email}`; // fallback to site_id if no instance_id

  try {
    const redis = getRedisClient();
    const isRateLimited = await redis.get(rateLimitKey);
    
    if (isRateLimited) {
      console.log(`[System Notification] Rate limited for key: ${rateLimitKey}`);
      return {
        whatsapp_sent: false,
        template_required: false,
        email_sent: false,
        notification_sent: false,
        user_id: null,
        instance_url: null,
        rate_limited: true,
        message: 'Notification skipped due to rate limit (once per hour per instance per user).'
      };
    }
    
    // Set the key to expire in 1 hour (3600 seconds)
    await redis.set(rateLimitKey, '1', 'EX', 3600);
  } catch (redisError) {
    console.error('[System Notification] Redis rate limiting failed, proceeding with notification:', redisError);
  }
  // --- END RATE LIMITING LOGIC ---

  // Find the user by email using profiles table first
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', team_member_email)
    .single();
    
  let user_id = profile?.id;
  let phone = phone_number || null;

  if (!phone && user_id) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(user_id);
    if (userData?.user) {
      phone = userData.user.phone || userData.user.user_metadata?.phone;
    }
  }

  let whatsappSent = false;
  let emailSent = false;
  let notificationSent = false;
  let templateRequired = false;

  // Defensively parse channels into an array
  let channelsList: string[] = [];
  if (Array.isArray(channels)) {
    channelsList = channels;
  } else if (typeof channels === 'string') {
    channelsList = [channels];
  }

  // Determine which channels to use
  const useExplicitChannels = channelsList.length > 0;
  const tryWhatsapp = useExplicitChannels ? channelsList.includes('whatsapp') : true;
  const tryInApp = useExplicitChannels ? channelsList.includes('in_app') : true;

  // The template should link to the instance_id
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
  const isUuid = (str?: string) => str && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  const validInstanceId = isUuid(instance_id) ? instance_id : undefined;

  const instanceUrl = validInstanceId 
    ? `${baseUrl}/sites/${site_id}/instances/${validInstanceId}`
    : `${baseUrl}/sites/${site_id}`;

  // Send WhatsApp if phone exists and channel is requested or default
  if (tryWhatsapp && phone) {
    const waMessage = `*${title}*\n\n${message}\n\nVer más detalles: ${instanceUrl}`;
    const waResult = await WhatsAppSendService.sendMessage({
      phone_number: phone,
      message: waMessage,
      from: 'Gear',
      site_id
    });
    whatsappSent = waResult.success;
    if (waResult.template_required) {
      templateRequired = true;
    }
  }

  // Always create an in-app notification if user exists and channel is requested or default
  if (tryInApp && user_id) {
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

  // Determine if email should be sent
  let tryEmail = false;
  if (useExplicitChannels) {
    tryEmail = channelsList.includes('email');
  } else {
    // Default fallback logic: send email if WhatsApp wasn't sent
    tryEmail = !whatsappSent;
  }

  if (tryEmail) {
    const htmlContent = `
      <!DOCTYPE html>
      <html>
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
            ${emailCtaButton(instanceUrl, 'Ver Instancia')}
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { AgentMailSendService } = await import('@/lib/services/email/AgentMailSendService');
      
      const emailResult = await AgentMailSendService.sendViaAgentMail({
        email: team_member_email,
        subject: title,
        message: message, // Pass the plain text message
        html: htmlContent, // Pass the HTML layout explicitly
        site_id,
        username: 'gear',
        domain: 'makinari.email',
        senderEmail: 'gear@makinari.email'
      });
      emailSent = emailResult.success;
    } catch (err) {
      console.error('Error sending system notification via AgentMail:', err);
      // Fallback to sendGrid
      const emailResult = await sendGridService.sendEmail({
        to: team_member_email,
        subject: title,
        html: htmlContent,
        from: { email: 'gear@makinari.email', name: 'Gear' },
        categories: ['system-notification']
      });
      emailSent = emailResult.success;
    }
  }

  return {
    whatsapp_sent: whatsappSent,
    template_required: templateRequired,
    email_sent: emailSent,
    notification_sent: notificationSent,
    user_id: user_id,
    instance_url: instanceUrl
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, site_id, team_member_email, instance_id, message, title, channels, phone_number } = body;

    // Handle "list" action
    if (action === 'list') {
      const data = await listSystemNotificationCore(site_id);
      return NextResponse.json({
        success: true,
        data
      });
    }

    // Handle "notify" action (default)
    const data = await notifySystemNotificationCore({
      site_id,
      team_member_email,
      instance_id,
      message,
      title,
      channels,
      phone_number
    });

    return NextResponse.json({
      success: true,
      data
    });

  } catch (error: any) {
    console.error('Error in system_notification tool:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message?.includes('required') ? 400 : 500 }
    );
  }
}
