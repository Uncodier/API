/**
 * AgentMail Quota Error Notification API
 * Route: POST /api/notifications/agentmailQuotaError
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';

// Schema for request validation
const AgentMailQuotaErrorSchema = z.object({
  site_id: z.string().uuid('Site ID must be a valid UUID'),
  error_type: z.enum(['agentmail_quota_exceeded', 'agentmail_domain_quota_exceeded']),
  error_message: z.string().min(1, 'Error message is required'),
  requested_resource: z.enum(['domain', 'inbox', 'unknown']),
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

// Branding functions for consistency
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Generate email HTML template
function generateQuotaErrorHtml(data: {
  siteName: string;
  errorMessage: string;
  requestedResource: string;
  failureTimestamp: string;
  priority: string;
  settingsUrl: string;
  supportUrl: string;
  logoUrl?: string;
}): string {
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', badge: '#e0f2fe' },
    normal: { bg: '#f8fafc', color: '#334155', badge: '#e2e8f0' },
    high: { bg: '#fff7ed', color: '#c2410c', badge: '#fed7aa' },
    urgent: { bg: '#fef2f2', color: '#dc2626', badge: '#fecaca' }
  };

  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors] || priorityColors.high;
  const resourceName = data.requestedResource === 'domain' ? 'Domain' : 'Inbox';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <meta name="format-detection" content="telephone=no, date=no, email=no, address=no">
    <title>AgentMail Quota Error - ${data.siteName}</title>
    <style>
        /* Mobile-first responsive design */
        @media screen and (max-width: 600px) {
            .container {
                margin: 10px !important;
                border-radius: 8px !important;
            }
            .header {
                padding: 24px 20px !important;
            }
            .content {
                padding: 24px 20px !important;
            }
            .footer {
                padding: 20px !important;
            }
            .section-spacing {
                margin-bottom: 20px !important;
            }
            .card-padding {
                padding: 16px 18px !important;
            }
            .button {
                padding: 14px 20px !important;
                font-size: 15px !important;
                min-height: 44px !important;
                width: auto !important;
                display: block !important;
                max-width: 280px !important;
                margin: 0 auto 12px !important;
                box-sizing: border-box !important;
            }
            .logo-container {
                width: 80px !important;
                height: 80px !important;
                padding: 12px !important;
            }
            .logo-image {
                width: 56px !important;
                height: 56px !important;
            }
            .main-title {
                font-size: 22px !important;
                line-height: 1.3 !important;
            }
            .section-title {
                font-size: 16px !important;
                line-height: 1.4 !important;
            }
            .error-icon {
                width: 20px !important;
                height: 20px !important;
                margin-right: 8px !important;
            }
            .error-title {
                font-size: 16px !important;
            }
            .button-container {
                text-align: center !important;
            }
        }
        
        /* Dark mode support */
        @media (prefers-color-scheme: dark) {
            .dark-mode-bg {
                background-color: #1f2937 !important;
            }
            .dark-mode-text {
                color: #f9fafb !important;
            }
        }
    </style>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
    
    <!-- Main Container -->
    <div class="container" style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 32px 40px; text-align: center;">
            ${data.logoUrl ? `
            <div class="logo-container" style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
                <img class="logo-image" src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
            </div>
            ` : `
            <div class="logo-container" style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
                <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto; display: flex; align-items: center; justify-content: center;">
                    <span style="font-size: 24px;">⚠️</span>
                </div>
            </div>
            `}
            <h1 class="main-title" style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">AgentMail Quota Limit Reached</h1>
            <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">${data.siteName}</p>
        </div>
        
        <!-- Content -->
        <div class="content" style="padding: 40px;">
          
            <!-- Priority Badge -->
            <div style="margin-bottom: 32px; text-align: center;">
                <div style="display: inline-block; background-color: ${priorityColor.badge}; color: ${priorityColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                    ${data.priority} Priority
                </div>
            </div>

            <!-- Alert Message -->
            <div class="section-spacing" style="background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 20px 24px; margin-bottom: 32px;">
                <div style="display: flex; align-items: center; margin-bottom: 15px;">
                    <div class="error-icon" style="width: 24px; height: 24px; background-color: #f59e0b; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0;">
                        <span style="color: white; font-size: 14px; font-weight: bold;">!</span>
                    </div>
                    <h2 class="error-title" style="color: #d97706; margin: 0; font-size: 18px; font-weight: 600;">${resourceName} Request Queued</h2>
                </div>
                <p style="color: #92400e; margin: 0; line-height: 1.7; font-size: 16px;">
                    Your ${resourceName.toLowerCase()} request has been received but cannot be created at this time due to quota limits. The request has been set to "requested" status and will be processed when resources become available.
                </p>
            </div>

            <!-- Error Details -->
            <div class="section-spacing" style="margin-bottom: 32px;">
                <h3 class="section-title" style="color: #374151; margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">Error Details</h3>
                <div class="card-padding" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px 24px;">
                    <p style="color: #6b7280; margin: 0 0 12px 0; font-size: 14px; font-weight: 500;">Error Message:</p>
                    <div style="color: #374151; margin: 0; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; font-size: 13px; background-color: #f3f4f6; padding: 12px; border-radius: 6px; word-break: break-word; line-height: 1.5; border: 1px solid #e5e7eb;">
                        ${data.errorMessage}
                    </div>
                </div>
            </div>

            <!-- What Happened -->
            <div class="section-spacing" style="margin-bottom: 32px;">
                <h3 class="section-title" style="color: #374151; margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">What Happened?</h3>
                <ul style="color: #6b7280; margin: 0; padding-left: 20px; line-height: 1.7; font-size: 15px;">
                    <li style="margin-bottom: 8px;">Your ${resourceName.toLowerCase()} creation request exceeded the available quota</li>
                    <li style="margin-bottom: 8px;">The request has been saved with status "requested" in your settings</li>
                    <li style="margin-bottom: 0;">You will be notified when the ${resourceName.toLowerCase()} becomes available</li>
                </ul>
            </div>

            <!-- Next Steps -->
            <div class="section-spacing" style="margin-bottom: 40px;">
                <h3 class="section-title" style="color: #374151; margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">Next Steps</h3>
                <ol style="color: #6b7280; margin: 0; padding-left: 20px; line-height: 1.7; font-size: 15px;">
                    <li style="margin-bottom: 8px;">Check your AgentMail account quota and limits</li>
                    <li style="margin-bottom: 8px;">Contact support if you need to upgrade your plan</li>
                    <li style="margin-bottom: 8px;">Monitor your settings for when the request is processed</li>
                    <li style="margin-bottom: 0;">The ${resourceName.toLowerCase()} will be created automatically when resources are available</li>
                </ol>
            </div>

            <!-- Action Buttons -->
            <div class="button-container" style="text-align: center; margin: 40px 0 32px;">
                <a href="${data.settingsUrl}" class="button" 
                   style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">
                    View Settings →
                </a>
                <a href="${data.supportUrl}" class="button"
                   style="display: inline-block; background: #ffffff; color: #3b82f6; border: 2px solid #3b82f6; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
                    Contact Support →
                </a>
            </div>
            
            <!-- Explanation -->
            <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
                <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
                    This quota error was automatically detected and your request has been queued.<br>
                    Your ${resourceName.toLowerCase()} will be created automatically when resources become available.
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div class="footer" style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0 0 12px; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
                <strong>Request Time:</strong> ${new Date(data.failureTimestamp).toLocaleString('en-US', { 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric', 
                    hour: '2-digit', 
                    minute: '2-digit',
                    timeZoneName: 'short'
                })}
            </p>
            <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
                This notification was automatically generated by ${getCompanyName()}.<br>
                If you need assistance, please contact our support team.
            </p>
        </div>
        
    </div>
    
    <!-- Powered by -->
    <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
            Powered by <strong style="color: #f59e0b;">${getBrandingText()}</strong>
        </p>
    </div>
    
</body>
</html>
`;
}

export async function POST(request: NextRequest) {
  try {
    console.log('⚠️ [AgentMailQuotaError] Starting AgentMail quota error notification');
    
    const body = await request.json();
    
    // Validate request body
    const validationResult = AgentMailQuotaErrorSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [AgentMailQuotaError] Validation error:', validationResult.error.errors);
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
      error_type,
      error_message,
      requested_resource,
      failure_timestamp,
      priority
    } = validationResult.data;
    
    console.log(`🔍 [AgentMailQuotaError] Processing notification for site: ${site_id}`);
    
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
    
    // URLs for the email
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const settingsUrl = `${baseUrl}/settings/channels`;
    const supportUrl = `${baseUrl}/support`;
    const logoUrl = process.env.UNCODIE_LOGO_URL;
    
    // Generate email content
    const emailHtml = generateQuotaErrorHtml({
      siteName: siteInfo.name || siteInfo.domain || 'Your Site',
      errorMessage: error_message,
      requestedResource: requested_resource,
      failureTimestamp: failure_timestamp || new Date().toISOString(),
      priority,
      settingsUrl,
      supportUrl,
      logoUrl
    });
    
    // Email subject
    const subject = `⚠️ AgentMail Quota Limit - ${siteInfo.name || siteInfo.domain}`;
    
    // Send email to site owner
    console.log(`📤 [AgentMailQuotaError] Sending notification to site owner: ${siteOwner.email}`);
    
    try {
      const emailResult = await sendGridService.sendEmail({
        to: siteOwner.email,
        subject,
        html: emailHtml,
        categories: ['agentmail-quota-error', 'system-notification', 'transactional'],
        customArgs: {
          siteId: site_id,
          notificationType: 'agentmail_quota_error',
          errorType: error_type,
          priority
        }
      });
      
      if (emailResult.success) {
        console.log(`✅ [AgentMailQuotaError] Notification sent successfully to ${siteOwner.email}`);
      } else {
        console.error('❌ [AgentMailQuotaError] Failed to send email:', emailResult.error);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'EMAIL_SEND_FAILED',
              message: 'Failed to send notification email',
              details: emailResult.error || 'Unknown error'
            }
          },
          { status: 500 }
        );
      }
    } catch (emailError) {
      console.error('❌ [AgentMailQuotaError] Failed to send email:', emailError);
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
      notification_id: `agentmail-quota-${site_id}-${Date.now()}`,
      data: {
        site_id,
        notification_sent: true,
        recipient: siteOwner.email,
        error_type,
        requested_resource: requested_resource,
        priority,
        failure_timestamp: failure_timestamp || new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('💥 [AgentMailQuotaError] Unexpected error:', error);
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
    message: "AgentMail Quota Error Notification API - sends notifications when AgentMail quota limits are reached",
    method: "POST",
    required_parameters: ["site_id", "error_type", "error_message", "requested_resource"],
    optional_parameters: ["failure_timestamp", "priority"],
    description: "Sends email notifications to site owners when AgentMail domain or inbox creation fails due to quota limits. The request is automatically set to 'requested' status in settings.channels.agent_email.",
    features: [
      "Validates site and owner information",
      "Sends detailed quota error notification with error message",
      "Includes action buttons for viewing settings and contacting support",
      "Supports priority levels (low, normal, high, urgent)",
      "Professional HTML email template with error details"
    ],
    priority_levels: ["low", "normal", "high", "urgent"],
    error_types: ["agentmail_quota_exceeded", "agentmail_domain_quota_exceeded"],
    requested_resources: ["domain", "inbox", "unknown"],
    response_fields: {
      site_id: "Site ID that experienced the quota error",
      notification_sent: "Whether notification was sent successfully",
      recipient: "Email address that received the notification",
      error_type: "Type of quota error",
      requested_resource: "Resource that was requested (domain or inbox)",
      priority: "Priority level of the notification",
      failure_timestamp: "When the quota error occurred"
    }
  }, { status: 200 });
}


