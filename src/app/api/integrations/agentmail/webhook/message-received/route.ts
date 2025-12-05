import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';
import { findMessageByAgentMailId, updateMessageWithAgentMailEvent } from '@/lib/integrations/agentmail/message-updater';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { WorkflowService } from '@/lib/services/workflow-service';

/**
 * POST handler for AgentMail message.received webhook event
 * Updates the message status when a message is received
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] message.received webhook received');

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Svix signature
    // Try specific secret, fallback to general secret via verifySvixWebhook
    const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET_MESSAGE_RECEIVED;
    let payload;
    try {
      payload = await verifySvixWebhook(body, webhookSecret);
    } catch (error: any) {
      // verifySvixWebhook will throw if neither specific nor general secret is configured
      console.error('❌ [AgentMail] Signature verification failed:', error.message);
      return NextResponse.json(
        { success: false, error: 'Webhook verification failed', details: error.message },
        { status: 401 }
      );
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

    // Find message in database
    const foundMessage = await findMessageByAgentMailId(message.message_id);

    if (!foundMessage) {
      console.log(`⚠️ [AgentMail] Message not found: ${message.message_id}`);
      return NextResponse.json(
        { success: false, error: 'Message not found', message_id: message.message_id },
        { status: 404 }
      );
    }

    // Update message with received event
    const updateResult = await updateMessageWithAgentMailEvent({
      messageId: foundMessage.id,
      status: 'received',
      eventType: 'message.received',
      eventMetadata: {
        inbox_id: message.inbox_id,
        thread_id: message.thread_id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        timestamp: message.timestamp,
      },
      timestamp: message.timestamp || payload.event_id,
    });

    if (!updateResult.success) {
      return NextResponse.json(
        { success: false, error: 'Failed to update message', details: updateResult.error },
        { status: 500 }
      );
    }

    console.log(`✅ [AgentMail] message.received processed successfully for message: ${message.message_id}`);

    // Trigger customerSupportWorkflow asynchronously (non-blocking)
    // Fetch complete message data and trigger workflow in background
    (async () => {
      try {
        // Fetch complete message data from database
        const { data: fullMessage, error: messageError } = await supabaseAdmin
          .from('messages')
          .select('id, conversation_id, visitor_id, lead_id, agent_id, content')
          .eq('id', foundMessage.id)
          .single();

        if (messageError || !fullMessage) {
          console.error(`❌ [AgentMail] Error fetching message data:`, messageError);
          return;
        }

        // Fetch conversation data to get site_id and user_id
        let siteId: string | undefined;
        let userId: string | undefined;

        if (fullMessage.conversation_id) {
          const { data: conversation, error: convError } = await supabaseAdmin
            .from('conversations')
            .select('site_id, user_id')
            .eq('id', fullMessage.conversation_id)
            .single();

          if (!convError && conversation) {
            siteId = conversation.site_id;
            userId = conversation.user_id;
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

        // Validate that we have at least the message content and one identifier
        if (!fullMessage.content) {
          console.warn(`⚠️ [AgentMail] Message content is empty, skipping workflow`);
          return;
        }

        if (!fullMessage.visitor_id && !fullMessage.lead_id && !userId && !siteId) {
          console.warn(`⚠️ [AgentMail] No identifiers found (visitor_id, lead_id, userId, or site_id), skipping workflow`);
          return;
        }

        // Call customerSupportWorkflow
        const workflowService = WorkflowService.getInstance();
        const workflowResult = await workflowService.customerSupportMessage(
          {
            conversationId: fullMessage.conversation_id,
            userId: userId,
            message: fullMessage.content,
            agentId: fullMessage.agent_id,
            site_id: siteId,
            lead_id: fullMessage.lead_id,
            visitor_id: fullMessage.visitor_id,
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

