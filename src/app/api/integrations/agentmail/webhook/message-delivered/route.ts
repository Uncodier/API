import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';
import { findMessageWithFallback, updateMessageWithAgentMailEvent } from '@/lib/integrations/agentmail/message-updater';

/**
 * POST handler for AgentMail message.delivered webhook event
 * Updates the message status when a message is delivered
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] message.delivered webhook received');

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Svix signature (optional - falls back to parsing JSON if verification fails)
    const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET_MESSAGE_DELIVERED;
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
    if (!payload || payload.type !== 'event' || payload.event_type !== 'message.delivered') {
      return NextResponse.json(
        { success: false, error: 'Invalid payload structure' },
        { status: 400 }
      );
    }

    // Handle both 'delivery' (new format) and 'message' (old format) properties
    const messageData = payload.delivery || payload.message;

    if (!messageData || !messageData.message_id) {
      return NextResponse.json(
        { success: false, error: 'Missing message_id in payload (checked delivery and message objects)' },
        { status: 400 }
      );
    }

    // Find message in database with fallback mechanism
    let recipient = messageData.recipients?.[0] || messageData.to;
    
    // Ensure recipient is a string, extract from array if needed
    if (Array.isArray(recipient)) {
      recipient = recipient[0];
    }
    
    const foundMessage = await findMessageWithFallback(
      messageData.message_id,
      {
        recipient,
        timestamp: messageData.timestamp || payload.event_id,
        subject: messageData.subject,
      }
    );

    if (!foundMessage) {
      console.log(`⚠️ [AgentMail] Message not found: ${messageData.message_id}`);
      // Return 200 instead of 404 to acknowledge the webhook and prevent Svix from retrying
      // This happens when messages are sent outside of Makinari or during dev testing
      return NextResponse.json(
        { success: true, skipped: 'not_found', message_id: messageData.message_id },
        { status: 200 }
      );
    }

    if (foundMessage.foundViaFallback) {
      console.log(`✅ [AgentMail] Message found via fallback search: ${foundMessage.id}`);
    }

    // Update message with delivered event
    const updateResult = await updateMessageWithAgentMailEvent({
      messageId: foundMessage.id,
      status: 'delivered',
      eventType: 'message.delivered',
      eventMetadata: {
        inbox_id: messageData.inbox_id,
        thread_id: messageData.thread_id,
        from: messageData.from,
        to: messageData.recipients || messageData.to,
        subject: messageData.subject,
        timestamp: messageData.timestamp,
        organization_id: messageData.organization_id,
        pod_id: messageData.pod_id,
      },
      timestamp: messageData.timestamp || payload.event_id,
      agentmailMessageId: foundMessage.foundViaFallback ? messageData.message_id : undefined,
    });

    if (!updateResult.success) {
      return NextResponse.json(
        { success: false, error: 'Failed to update message', details: updateResult.error },
        { status: 500 }
      );
    }

    console.log(`✅ [AgentMail] message.delivered processed successfully for message: ${messageData.message_id}`);

    return NextResponse.json(
      { success: true, message_id: messageData.message_id, event_type: 'message.delivered' },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ [AgentMail] Error processing message.delivered webhook:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}
