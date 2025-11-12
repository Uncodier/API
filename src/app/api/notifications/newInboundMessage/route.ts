import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { z } from 'zod';

// Configure maximum timeout to 2 minutes
export const maxDuration = 120;

// Validation schema for the request
const NewInboundMessageSchema = z.object({
  lead_id: z.string().uuid('lead_id must be a valid UUID'),
  message: z.string().min(1, 'message is required'),
  conversation_id: z.string().uuid('conversation_id must be a valid UUID'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().default('normal')
});

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Function to get site_id from conversation_id
async function getSiteIdFromConversation(conversationId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('site_id')
      .eq('id', conversationId)
      .single();
    
    if (error) {
      console.error('Error getting site_id from conversation:', error);
      return null;
    }
    
    return data?.site_id || null;
  } catch (error) {
    console.error('Error getting site_id from conversation:', error);
    return null;
  }
}

// Function to get lead information
async function getLeadInfo(leadId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();
    
    if (error) {
      console.error('Error getting lead information:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting lead information:', error);
    return null;
  }
}

// Function to get site information
async function getSiteInfo(siteId: string): Promise<any | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', siteId)
      .single();
    
    if (error) {
      console.error('Error getting site information:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting site information:', error);
    return null;
  }
}

// Branding functions
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Uncodie, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Uncodie';
}

// Function to generate HTML email template for team notification
function generateNewInboundMessageHtml(data: {
  leadName: string;
  leadEmail: string;
  message: string;
  siteName: string;
  conversationUrl: string;
  logoUrl?: string;
  priority: string;
}): string {
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', badge: '#e0f2fe' },
    normal: { bg: '#f8fafc', color: '#334155', badge: '#e2e8f0' },
    high: { bg: '#fff7ed', color: '#c2410c', badge: '#fed7aa' },
    urgent: { bg: '#fef2f2', color: '#dc2626', badge: '#fecaca' }
  };
  
  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors] || priorityColors.normal;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Inbound Message - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #ffffff; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #10b981; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Inbound Message</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">You have a new message to review</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Priority Badge -->
          <div style="margin-bottom: 32px; text-align: center;">
            <div style="display: inline-block; background-color: ${priorityColor.bg}; color: ${priorityColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${data.priority} priority
            </div>
          </div>
          
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Lead Information</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Name:</span>
                <span style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
              </div>
              <div>
                <span style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Email:</span>
                <a href="mailto:${data.leadEmail}" style="color: #3b82f6; text-decoration: none; font-size: 15px;">
                  ${data.leadEmail}
                </a>
              </div>
            </div>
          </div>
          
          <!-- Message -->
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Message</h3>
            <div style="background-color: #f1f5f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div style="color: #1e293b; font-size: 16px; line-height: 1.7; white-space: pre-wrap;">
                ${data.message}
              </div>
            </div>
          </div>
          
          <!-- Action Button -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.conversationUrl}" 
               style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s;">
              View Conversation →
            </a>
          </div>
          
          <!-- Explanation -->
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.5;">
              Click the button above to view and respond to this message in the chat interface.
            </p>
          </div>
          
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">
            This notification was automatically generated by ${getCompanyName()}.<br>
            Manage your notification preferences in your account settings.
          </p>
        </div>
        
      </div>
      
      <!-- Powered by -->
      <div style="text-align: center; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
          Powered by <strong style="color: #667eea;">${getBrandingText()}</strong>
        </p>
      </div>
      
    </body>
    </html>
  `;
}

export async function POST(request: NextRequest) {
  try {
    console.log('📧 [NewInboundMessage] Starting new inbound message notification');
    
    const body = await request.json();
    
    // Validate request body
    const validationResult = NewInboundMessageSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [NewInboundMessage] Validation error:', validationResult.error.errors);
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
      lead_id,
      message,
      conversation_id,
      priority
    } = validationResult.data;
    
    console.log(`📋 [NewInboundMessage] Processing notification for lead: ${lead_id}, conversation: ${conversation_id}`);
    
    // Get site_id from conversation_id (primary method)
    let siteId = await getSiteIdFromConversation(conversation_id);
    
    // Fallback: get site_id from lead_id if not found in conversation
    if (!siteId) {
      console.log(`⚠️ [NewInboundMessage] site_id not found in conversation, trying lead_id...`);
      const leadInfo = await getLeadInfo(lead_id);
      if (leadInfo?.site_id) {
        siteId = leadInfo.site_id;
        console.log(`✅ [NewInboundMessage] site_id obtained from lead: ${siteId}`);
      }
    } else {
      console.log(`✅ [NewInboundMessage] site_id obtained from conversation: ${siteId}`);
    }
    
    if (!siteId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SITE_ID_NOT_FOUND',
            message: 'Could not determine site_id from conversation_id or lead_id'
          }
        },
        { status: 404 }
      );
    }
    
    // Get lead information
    const leadInfo = await getLeadInfo(lead_id);
    if (!leadInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'LEAD_NOT_FOUND',
            message: 'Lead not found'
          }
        },
        { status: 404 }
      );
    }
    
    // Get site information
    const siteInfo = await getSiteInfo(siteId);
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
    
    // Build conversation URL
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
    const conversationUrl = `${baseUrl}/chat?conversation_id=${conversation_id}`;
    
    console.log(`📢 [NewInboundMessage] Notifying team...`);
    
    const results = {
      success: true,
      notifications_sent: 0,
      emails_sent: 0,
      errors: [] as string[]
    };
    
    try {
      const leadName = leadInfo.name || 'Unknown Lead';
      const leadEmail = leadInfo.email || 'No email';
      
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: siteId,
        title: `New Inbound Message from ${leadName}`,
        message: `You have received a new message from ${leadName}: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        htmlContent: generateNewInboundMessageHtml({
          leadName,
          leadEmail,
          message,
          siteName: siteInfo.name || 'Unknown Site',
          conversationUrl,
          logoUrl: siteInfo.logo_url,
          priority: priority as string
        }),
        priority: priority as any,
        type: NotificationType.INFO,
        categories: ['inbound-message', 'conversation-notification'],
        customArgs: {
          leadId: lead_id,
          conversationId: conversation_id,
          siteId: siteId
        },
        relatedEntityType: 'conversation',
        relatedEntityId: conversation_id
      });
      
      if (teamNotificationResult.success) {
        results.notifications_sent = teamNotificationResult.notificationsSent;
        results.emails_sent = teamNotificationResult.emailsSent;
        console.log(`✅ [NewInboundMessage] Team notified: ${teamNotificationResult.notificationsSent} notifications, ${teamNotificationResult.emailsSent} emails`);
      } else {
        const errorMsg = `Failed to notify team: ${teamNotificationResult.errors?.join(', ') || 'Unknown error'}`;
        results.errors.push(errorMsg);
        results.success = false;
        console.error(`❌ [NewInboundMessage] ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = `Error notifying team: ${error instanceof Error ? error.message : 'Unknown error'}`;
      results.errors.push(errorMsg);
      results.success = false;
      console.error(`❌ [NewInboundMessage] ${errorMsg}`, error);
    }
    
    console.log(`📊 [NewInboundMessage] Notification summary:`, {
      success: results.success,
      notifications_sent: results.notifications_sent,
      emails_sent: results.emails_sent,
      errors: results.errors.length
    });
    
    return NextResponse.json({
      success: results.success,
      data: {
        lead_id,
        conversation_id,
        site_id: siteId,
        lead_info: {
          name: leadInfo.name,
          email: leadInfo.email
        },
        site_info: {
          name: siteInfo.name
        },
        notifications_sent: results.notifications_sent,
        emails_sent: results.emails_sent,
        conversation_url: conversationUrl,
        errors: results.errors.length > 0 ? results.errors : undefined,
        sent_at: new Date().toISOString()
      }
    }, { 
      status: results.success ? 200 : (results.errors.length > 0 ? 207 : 500) // 207 = Multi-Status (partial success)
    });
    
  } catch (error) {
    console.error('❌ [NewInboundMessage] General error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: 'An internal system error occurred'
        }
      },
      { status: 500 }
    );
  }
}

