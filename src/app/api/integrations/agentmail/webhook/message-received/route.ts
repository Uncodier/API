import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { WorkflowService } from '@/lib/services/workflow-service';
import { findMessageByAgentMailId } from '@/lib/integrations/agentmail/message-updater';
import { ConversationService } from '@/lib/services/conversation-service';

/**
 * POST handler for AgentMail message.received webhook event
 * Triggers customerSupport workflow for incoming messages
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] message.received webhook received');

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Svix signature (optional - falls back to parsing JSON if verification fails)
    const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET_MESSAGE_RECEIVED;
    let payload = await verifySvixWebhook(body, webhookSecret);
    
    // If verification failed or secret not configured, parse body directly
    if (!payload) {
      console.warn('⚠️ [AgentMail] Signature verification skipped, parsing body directly');
      try {
        payload = JSON.parse(body);
      } catch (parseError: any) {
        console.error('❌ [AgentMail] Failed to parse webhook body:', parseError.message);
        return NextResponse.json(
          { success: false, error: 'Invalid JSON payload' },
          { status: 400 }
        );
      }
    }

    // Validate payload structure
    if (!payload || payload.type !== 'event' || payload.event_type !== 'message.received') {
      return NextResponse.json(
        { success: false, error: 'Invalid payload structure' },
        { status: 400 }
      );
    }

    const message = payload.message;
    if (!message || !message.message_id) {
      return NextResponse.json(
        { success: false, error: 'Missing message.message_id in payload' },
        { status: 400 }
      );
    }

    console.log(`📨 [AgentMail] Processing incoming message: ${message.message_id}`);

    // Check if message was already processed (prevent duplicates)
    const existingMessage = await findMessageByAgentMailId(message.message_id);
    if (existingMessage) {
      console.log(`⚠️ [AgentMail] Message ${message.message_id} already processed, skipping duplicate`);
      return NextResponse.json(
        { 
          success: true, 
          message_id: message.message_id, 
          event_type: 'message.received', 
          skipped: 'duplicate',
          existing_message_id: existingMessage.id
        },
        { status: 200 }
      );
    }

    // Get site_id from inbox_id or domain
    let siteId: string | undefined;
    let userId: string | undefined;

    // First try to find by inbox_id
    if (message.inbox_id) {
      const { data: settings, error: settingsError } = await supabaseAdmin
        .from('settings')
        .select('site_id')
        .filter('channels->agent_email->>inbox_id', 'eq', message.inbox_id)
        .single();

      if (!settingsError && settings) {
        siteId = settings.site_id;
      } else {
        console.warn(`⚠️ [AgentMail] inbox_id not found in settings: ${message.inbox_id}`);
        
        // If inbox_id lookup failed, try to find by domain
        // Extract domain from inbox_id (format: username@domain.com)
        const domainMatch = message.inbox_id.match(/@(.+)$/);
        if (domainMatch && domainMatch[1]) {
          const domain = domainMatch[1].toLowerCase().trim();
          console.log(`🔍 [AgentMail] Trying to find site_id by domain: ${domain}`);
          
          const { data: settingsByDomain, error: domainError } = await supabaseAdmin
            .from('settings')
            .select('site_id')
            .filter('channels->agent_email->>domain', 'eq', domain)
            .single();

          if (!domainError && settingsByDomain) {
            siteId = settingsByDomain.site_id;
            console.log(`✅ [AgentMail] Found site_id by domain: ${siteId}`);
          } else {
            console.warn(`⚠️ [AgentMail] Domain not found in settings: ${domain}`);
          }
        }
      }
    }

    // Get user_id from site if we found a site_id
        if (siteId) {
          const { data: site, error: siteError } = await supabaseAdmin
            .from('sites')
            .select('user_id')
            .eq('id', siteId)
            .single();
          
          if (!siteError && site) {
            userId = site.user_id;
      }
    }

    // Extract email and name from message.from field
    // Format can be: "Name <email@example.com>" or just "email@example.com"
    let email: string | undefined;
    let name: string | undefined;

    if (message.from) {
      const fromMatch = message.from.match(/^(.+?)\s*<(.+?)>$|^(.+?)$/);
      if (fromMatch) {
        if (fromMatch[2]) {
          // Format: "Name <email@example.com>"
          name = fromMatch[1].trim();
          email = fromMatch[2].trim();
        } else if (fromMatch[3]) {
          // Format: "email@example.com" or just the email
          const potentialEmail = fromMatch[3].trim();
          if (potentialEmail.includes('@')) {
            email = potentialEmail;
          } else {
            name = potentialEmail;
          }
        }
      }
    }

    // Extract message content from payload
    const messageContent = message.body || message.text || message.content || message.html || '';

    // Validate that we have at least the message content and one identifier
    if (!messageContent) {
      console.warn(`⚠️ [AgentMail] Message content is empty, skipping workflow`);
      return NextResponse.json(
        { success: true, message_id: message.message_id, event_type: 'message.received', skipped: 'no_content' },
        { status: 200 }
      );
    }

    if (!siteId && !userId && !email) {
      console.warn(`⚠️ [AgentMail] No identifiers found (site_id, userId, or email), skipping workflow`);
      return NextResponse.json(
        { success: true, message_id: message.message_id, event_type: 'message.received', skipped: 'no_identifiers' },
        { status: 200 }
      );
    }

    // Find lead by email and existing email conversation
    let leadId: string | undefined;
    let conversationId: string | undefined;

    if (email && siteId) {
      try {
        // Find lead by email
        const { data: lead, error: leadError } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('email', email.toLowerCase().trim())
          .eq('site_id', siteId)
          .limit(1)
          .single();

        if (!leadError && lead) {
          leadId = lead.id;
          console.log(`✅ [AgentMail] Found lead by email: ${leadId}`);

          // Find existing open email conversation for this lead
          const existingConversationId = await ConversationService.findExistingConversation(
            leadId,
            undefined, // visitorId
            siteId,
            'email' // origin/channel
          );

          if (existingConversationId) {
            conversationId = existingConversationId;
            console.log(`✅ [AgentMail] Found existing email conversation: ${conversationId}`);
          } else {
            console.log(`ℹ️ [AgentMail] No existing email conversation found for lead ${leadId}`);
          }
        } else {
          console.log(`ℹ️ [AgentMail] No lead found for email: ${email}`);
        }
      } catch (error: any) {
        console.warn(`⚠️ [AgentMail] Error finding lead/conversation:`, error.message);
        // Continue without lead/conversation - workflow will create them if needed
      }
    }

    // Trigger customerSupportWorkflow asynchronously (non-blocking)
    (async () => {
      try {
        const workflowService = WorkflowService.getInstance();
        const workflowResult = await workflowService.customerSupportMessage(
          {
            conversationId: conversationId, // Use existing conversation if found
            userId: userId,
            message: messageContent,
            agentId: undefined, // Workflow will determine agent
            site_id: siteId,
            lead_id: leadId, // Use existing lead if found
            visitor_id: undefined,
            name: name,
            email: email,
            origin: 'email',
          },
          {
            priority: 'high',
            async: false,
            retryAttempts: 3,
            taskQueue: 'high',
            workflowId: `customer-support-email-${siteId || 'nosid'}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          }
        );

        if (workflowResult.success) {
          console.log(`✅ [AgentMail] customerSupportWorkflow triggered successfully: ${workflowResult.workflowId}`);
        } else {
          console.error(`❌ [AgentMail] Error triggering customerSupportWorkflow:`, workflowResult.error);
        }
      } catch (error: any) {
        // Log error but don't fail the webhook
        console.error(`❌ [AgentMail] Error in customerSupportWorkflow trigger:`, error);
      }
    })();

    return NextResponse.json(
      { success: true, message_id: message.message_id, event_type: 'message.received' },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ [AgentMail] Error processing message.received webhook:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}

