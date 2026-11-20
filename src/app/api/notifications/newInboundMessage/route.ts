import { generateNewInboundMessageHtml } from './email-template';
import { NextRequest, NextResponse } from 'next/server';
import { notificationMessage } from '../_utils/details';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType, NotificationCategory } from '@/lib/services/notification-service';
import { platformT } from '@/lib/i18n/email-messages/platform';
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

// A team notification may only link to a real inbound customer conversation.
async function getSiteIdFromConversation(conversationId: string, leadId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('conversations').select('site_id,channel,lead_id')
    .eq('id', conversationId).eq('lead_id', leadId).maybeSingle();
  if (error || data?.channel === 'internal_review' || data?.lead_id !== leadId) return null;
  return data.site_id || null;
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
    
    const siteId = await getSiteIdFromConversation(conversation_id, lead_id);
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
    const conversationUrl = `${baseUrl}/chat?conversationId=${conversation_id}`;
    
    console.log(`📢 [NewInboundMessage] Notifying team...`);
    
    const results = {
      success: true,
      notifications_sent: 0,
      emails_sent: 0,
      errors: [] as string[]
    };
    
    try {
      const leadName = leadInfo.name || 'Unknown Lead';
      // Use email if available, otherwise use phone, otherwise use fallback text
      const leadContact = leadInfo.email || leadInfo.phone || 'No contact info';
      const contactType: 'email' | 'phone' = leadInfo.email ? 'email' : (leadInfo.phone ? 'phone' : 'email');
      
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: siteId,
        title: `New Inbound Message from ${leadName}`,
        message: notificationMessage(`You have received a new message from ${leadName}.`, [
          ['Message', message], ['Contact', leadContact], ['Priority', priority], ['Site', siteInfo.name]
        ]),
        buildEmail: (locale) => ({
          subject: platformT(locale, 'new_inbound_message.subject', { leadName }),
          html: generateNewInboundMessageHtml({
            leadName,
            leadEmail: leadContact,
            message,
            siteName: siteInfo.name || 'Unknown Site',
            conversationUrl,
            logoUrl: siteInfo.logo_url,
            priority: priority as string,
            contactType,
            locale
          })
        }),
        priority: priority as any,
        type: NotificationType.INFO,
        categories: [NotificationCategory.HUMAN_INTERVENTION],
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
          email: leadInfo.email,
          phone: leadInfo.phone,
          contact_method: leadInfo.email ? 'email' : (leadInfo.phone ? 'phone' : 'none')
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

