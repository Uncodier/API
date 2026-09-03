import { NextRequest, NextResponse } from 'next/server';
import { getConversationChannel, sendMessageByChannel } from '../intervention/send-intervention-by-channel';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      conversation_id,
      message,
      site_id,
      agent_id,
      lead_id,
      message_id,
      channel: requestedChannel,
    } = body;

    if (!conversation_id || !message || !site_id) {
      return NextResponse.json(
        { success: false, error: 'conversation_id, message and site_id are required' },
        { status: 400 }
      );
    }

    const conversationInfo = await getConversationChannel(conversation_id);
    const channel = requestedChannel || conversationInfo?.channel;

    if (!channel) {
      return NextResponse.json(
        { success: false, error: 'Could not resolve conversation channel' },
        { status: 400 }
      );
    }

    const result = await sendMessageByChannel(
      channel,
      message,
      {
        leadPhone: conversationInfo?.leadPhone,
        leadEmail: conversationInfo?.leadEmail,
        visitorPhone: conversationInfo?.visitorPhone,
        channelDelivery: conversationInfo?.channelDelivery === true,
      },
      site_id,
      agent_id,
      conversation_id,
      lead_id,
      message_id
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to start channel send' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      workflowId: result.workflowId,
      workflowStarted: result.workflowStarted,
      method: result.method,
    });
  } catch (error) {
    console.error('[send-by-channel] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
