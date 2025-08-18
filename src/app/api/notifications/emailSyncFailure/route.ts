/**
 * Email Sync Failure Notification API
 * Route: POST /api/notifications/emailSyncFailure
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmailService } from '@/lib/services/email/EmailService';

// Schema for request validation
const EmailSyncFailureSchema = z.object({
  site_id: z.string().uuid('Site ID must be a valid UUID'),
  error_message: z.string().min(1, 'Error message is required'),
  failure_timestamp: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('high')
});

// Get site information
async function getSiteInfo(siteId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('name, domain, user_id')
      .eq('id', siteId)
      .single();

    if (error) {
      console.error('Error getting site info:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error in getSiteInfo:', error);
    return null;
  }
}

// Get site email configuration
async function getSiteEmailConfig(siteId: string): Promise<{email: string | null, aliases: string[]}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();

    if (error || !data?.channels?.email) {
      console.warn('No email configuration found for site:', siteId);
      return { email: null, aliases: [] };
    }

    const emailConfig = data.channels.email;
    return {
      email: emailConfig.email || null,
      aliases: emailConfig.aliases || []
    };
  } catch (error) {
    console.error('Error getting site email config:', error);
    return { email: null, aliases: [] };
  }
}

// Get site owner information
async function getSiteOwner(siteId: string): Promise<{email: string, name?: string} | null> {
  try {
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', siteId)
      .single();

    if (siteError || !site) {
      console.error('Error getting site:', siteError);
      return null;
    }

    // Get user information from auth
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(site.user_id);
    
    if (userError || !userData.user) {
      console.error('Error getting user:', userError);
      return null;
    }

    return {
      email: userData.user.email!,
      name: userData.user.user_metadata?.name || userData.user.user_metadata?.full_name
    };
  } catch (error) {
    console.error('Error in getSiteOwner:', error);
    return null;
  }
}

// Generate email HTML template
function generateEmailSyncFailureHtml(data: {
  siteName: string;
  errorMessage: string;
  failureTimestamp: string;
  priority: string;
  settingsUrl: string;
  supportUrl: string;
  logoUrl?: string;
}): string {
  const priorityColors = {
    low: '#10B981',
    normal: '#3B82F6', 
    high: '#F59E0B',
    urgent: '#EF4444'
  };

  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors] || '#F59E0B';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Email Sync Failure - ${data.siteName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc;">
    <div style="max-width: 600px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px 20px; text-align: center;">
            ${data.logoUrl ? `<img src="${data.logoUrl}" alt="Logo" style="max-height: 40px; margin-bottom: 15px;">` : ''}
            <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 600;">Email Sync Failure Alert</h1>
            <p style="color: rgba(255, 255, 255, 0.9); margin: 8px 0 0 0; font-size: 16px;">${data.siteName}</p>
        </div>

        <!-- Priority Badge -->
        <div style="padding: 20px; border-bottom: 1px solid #e5e7eb;">
            <div style="display: inline-block; background-color: ${priorityColor}; color: white; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase;">
                ${data.priority} Priority
            </div>
        </div>

        <!-- Main Content -->
        <div style="padding: 30px 20px;">
            <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
                <div style="display: flex; align-items: center; margin-bottom: 15px;">
                    <div style="width: 24px; height: 24px; background-color: #ef4444; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 12px;">
                        <span style="color: white; font-size: 14px; font-weight: bold;">!</span>
                    </div>
                    <h2 style="color: #dc2626; margin: 0; font-size: 18px; font-weight: 600;">Email Synchronization Failed</h2>
                </div>
                <p style="color: #7f1d1d; margin: 0; line-height: 1.6;">
                    Your email synchronization has failed and has been automatically disabled to prevent further issues.
                </p>
            </div>

            <div style="margin-bottom: 25px;">
                <h3 style="color: #374151; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">Error Details</h3>
                <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 15px;">
                    <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px; font-weight: 500;">Error Message:</p>
                    <p style="color: #374151; margin: 0; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; font-size: 13px; background-color: #f3f4f6; padding: 10px; border-radius: 4px; word-break: break-word;">
                        ${data.errorMessage}
                    </p>
                </div>
            </div>

            <div style="margin-bottom: 25px;">
                <h3 style="color: #374151; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">What Happened?</h3>
                <ul style="color: #6b7280; margin: 0; padding-left: 20px; line-height: 1.6;">
                    <li>Email synchronization encountered a connection or authentication error</li>
                    <li>The email channel has been automatically disabled to prevent further failures</li>
                    <li>No emails will be synchronized until the issue is resolved</li>
                </ul>
            </div>

            <div style="margin-bottom: 30px;">
                <h3 style="color: #374151; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">Next Steps</h3>
                <ol style="color: #6b7280; margin: 0; padding-left: 20px; line-height: 1.6;">
                    <li>Check your email server settings and credentials</li>
                    <li>Verify that your email provider allows IMAP connections</li>
                    <li>Update your email configuration if needed</li>
                    <li>Re-enable email synchronization once the issue is fixed</li>
                </ol>
            </div>

            <!-- Action Buttons -->
            <div style="text-align: center; margin-bottom: 20px;">
                <a href="${data.settingsUrl}" style="display: inline-block; background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin-right: 10px;">
                    Fix Email Settings
                </a>
                <a href="${data.supportUrl}" style="display: inline-block; background-color: #6b7280; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
                    Get Support
                </a>
            </div>
        </div>

        <!-- Footer -->
        <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
            <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px;">
                <strong>Failure Time:</strong> ${new Date(data.failureTimestamp).toLocaleString()}
            </p>
            <p style="color: #9ca3af; margin: 0; font-size: 12px;">
                This is an automated notification from Uncodie. If you need assistance, please contact our support team.
            </p>
        </div>
    </div>
</body>
</html>
`;
}

export async function POST(request: NextRequest) {
  try {
    console.log('🚨 [EmailSyncFailure] Starting email sync failure notification');
    
    const body = await request.json();
    
    // Validate request body
    const validationResult = EmailSyncFailureSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [EmailSyncFailure] Validation error:', validationResult.error.errors);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        },
        { status: 400 }
      );
    }
    
    const {
      site_id,
      error_message,
      failure_timestamp,
      priority
    } = validationResult.data;
    
    console.log(`🔍 [EmailSyncFailure] Processing notification for site: ${site_id}`);
    
    // Get site information
    const siteInfo = await getSiteInfo(site_id);
    if (!siteInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SITE_NOT_FOUND',
            message: 'Site not found'
          }
        },
        { status: 404 }
      );
    }
    
    // Get site owner
    const siteOwner = await getSiteOwner(site_id);
    if (!siteOwner) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SITE_OWNER_NOT_FOUND',
            message: 'Site owner not found'
          }
        },
        { status: 404 }
      );
    }
    
    // Get site email configuration for reply-to
    const siteEmailConfig = await getSiteEmailConfig(site_id);
    const replyEmail = siteEmailConfig.aliases.length > 0 ? siteEmailConfig.aliases[0] : siteEmailConfig.email;
    
    console.log(`📧 [EmailSyncFailure] Site email config:`, {
      email: siteEmailConfig.email,
      aliases: siteEmailConfig.aliases,
      replyEmail
    });
    
    // URLs for the email
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const settingsUrl = `${baseUrl}/settings/channels`;
    const supportUrl = `${baseUrl}/support`;
    const logoUrl = process.env.UNCODIE_LOGO_URL;
    
    // Generate email content
    const emailHtml = generateEmailSyncFailureHtml({
      siteName: siteInfo.name || siteInfo.domain || 'Your Site',
      errorMessage: error_message,
      failureTimestamp: failure_timestamp || new Date().toISOString(),
      priority,
      settingsUrl,
      supportUrl,
      logoUrl
    });
    
    // Email subject
    const subject = `🚨 Email Sync Failure - ${siteInfo.name || siteInfo.domain}`;
    
    // Send email to site owner
    console.log(`📤 [EmailSyncFailure] Sending notification to site owner: ${siteOwner.email}`);
    
    try {
      await EmailService.sendEmail({
        to: siteOwner.email,
        subject,
        html: emailHtml,
        replyTo: replyEmail || undefined
      });
      
      console.log(`✅ [EmailSyncFailure] Notification sent successfully to ${siteOwner.email}`);
    } catch (emailError) {
      console.error('❌ [EmailSyncFailure] Failed to send email:', emailError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'EMAIL_SEND_FAILED',
            message: 'Failed to send notification email',
            details: emailError instanceof Error ? emailError.message : 'Unknown error'
          }
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      data: {
        site_id,
        notification_sent: true,
        recipient: siteOwner.email,
        priority,
        failure_timestamp: failure_timestamp || new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('💥 [EmailSyncFailure] Unexpected error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      },
      { status: 500 }
    );
  }
}

// GET method for endpoint information
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "Email Sync Failure Notification API - sends notifications when email synchronization fails",
    method: "POST",
    required_parameters: ["site_id", "error_message"],
    optional_parameters: ["failure_timestamp", "priority"],
    description: "Sends email notifications to site owners when email synchronization fails. Automatically updates settings.channels to mark email as failed and disabled.",
    features: [
      "Validates site and owner information",
      "Sends detailed failure notification with error message",
      "Includes action buttons for fixing settings and getting support",
      "Uses site email configuration for reply-to address",
      "Supports priority levels (low, normal, high, urgent)",
      "Professional HTML email template with error details"
    ],
    priority_levels: ["low", "normal", "high", "urgent"],
    response_fields: {
      site_id: "Site ID that experienced the failure",
      notification_sent: "Whether notification was sent successfully",
      recipient: "Email address that received the notification",
      priority: "Priority level of the notification",
      failure_timestamp: "When the failure occurred"
    }
  }, { status: 200 });
}
