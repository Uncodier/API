import { NextRequest, NextResponse } from 'next/server';
import { getConversationChannel, sendMessageByChannel } from '../intervention/send-intervention-by-channel';
import { validateOutboundMedia, OutboundMediaError } from '@/lib/services/channels/outbound-media';
import { canAccessSite } from '@/lib/security/site-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';

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

    if (!conversation_id || !site_id || (message !== undefined && typeof message !== 'string')) {
      return NextResponse.json(
        { success: false, error: 'conversation_id, message and site_id are required' },
        { status: 400 }
      );
    }

    if (!await canAccessSite(request, site_id)) return NextResponse.json({ success: false, error: 'Site access denied' }, { status: 403 });
    const scoped = await supabaseAdmin.from('conversations').select('id').eq('id', conversation_id).eq('site_id', site_id).maybeSingle();
    if (scoped.error || !scoped.data) return NextResponse.json({ success: false, error: 'Conversation access denied' }, { status: 403 });
    const conversationInfo = await getConversationChannel(conversation_id);
    const channel = requestedChannel || conversationInfo?.channel;

    if (!channel) {
      return NextResponse.json(
        { success: false, error: 'Could not resolve conversation channel' },
        { status: 400 }
      );
    }
    const media = await validateOutboundMedia(body, channel);
    if (!message?.trim() && !media) return NextResponse.json({ success: false, error: 'message or media is required' }, { status: 400 });

    const result = await sendMessageByChannel(
      channel,
      message || '',
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
      message_id,
      body.response_format,
      body,
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
    if (error instanceof OutboundMediaError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    console.error('[send-by-channel] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
