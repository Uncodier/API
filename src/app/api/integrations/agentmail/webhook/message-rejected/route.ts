import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';
import { findMessageByAgentMailId, updateMessageWithAgentMailEvent } from '@/lib/integrations/agentmail/message-updater';

/**
 * POST handler for AgentMail message.rejected webhook event
 * Updates the message status when a message is rejected
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] message.rejected webhook received');

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Svix signature
    let payload;
    try {
      payload = await verifySvixWebhook(body);
    } catch (error: any) {
      console.error('❌ [AgentMail] Signature verification failed:', error.message);
      return NextResponse.json(
        { success: false, error: 'Webhook verification failed', details: error.message },
        { status: 401 }
      );
    }

    // Validate payload structure
    if (!payload || payload.type !== 'event' || payload.event_type !== 'message.rejected') {
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

    // Update message with rejected event
    const updateResult = await updateMessageWithAgentMailEvent({
      messageId: foundMessage.id,
      status: 'rejected',
      eventType: 'message.rejected',
      eventMetadata: {
        inbox_id: message.inbox_id,
        thread_id: message.thread_id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        timestamp: message.timestamp,
        rejection_reason: message.rejection_reason || 'Unknown',
      },
      timestamp: message.timestamp || payload.event_id,
    });

    if (!updateResult.success) {
      return NextResponse.json(
        { success: false, error: 'Failed to update message', details: updateResult.error },
        { status: 500 }
      );
    }

    console.log(`✅ [AgentMail] message.rejected processed successfully for message: ${message.message_id}`);

    return NextResponse.json(
      { success: true, message_id: message.message_id, event_type: 'message.rejected' },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ [AgentMail] Error processing message.rejected webhook:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}

