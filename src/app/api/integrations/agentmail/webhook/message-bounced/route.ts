import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';
import { findMessageByAgentMailId, updateMessageWithAgentMailEvent } from '@/lib/integrations/agentmail/message-updater';

/**
 * POST handler for AgentMail message.bounced webhook event
 * Updates the message status when a message bounces
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] message.bounced webhook received');

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Svix signature (optional - falls back to parsing JSON if verification fails)
    const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET_MESSAGE_BOUNCED;
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
    if (!payload || payload.type !== 'event' || payload.event_type !== 'message.bounced') {
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

    // Update message with bounced event
    const updateResult = await updateMessageWithAgentMailEvent({
      messageId: foundMessage.id,
      status: 'bounced',
      eventType: 'message.bounced',
      eventMetadata: {
        inbox_id: message.inbox_id,
        thread_id: message.thread_id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        timestamp: message.timestamp,
        bounce_reason: message.bounce_reason || 'Unknown',
      },
      timestamp: message.timestamp || payload.event_id,
    });

    if (!updateResult.success) {
      return NextResponse.json(
        { success: false, error: 'Failed to update message', details: updateResult.error },
        { status: 500 }
      );
    }

    console.log(`✅ [AgentMail] message.bounced processed successfully for message: ${message.message_id}`);

    return NextResponse.json(
      { success: true, message_id: message.message_id, event_type: 'message.bounced' },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ [AgentMail] Error processing message.bounced webhook:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}

