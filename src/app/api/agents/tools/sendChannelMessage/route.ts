import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';

/**
 * Sends an outbound message on a connected channel (telegram, messenger).
 */
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const {
      channel,
      to,
      message,
      site_id,
      agent_id,
      conversation_id,
      lead_id,
      message_id,
      subject,
    } = payload;

    if (!channel || !to || !message || !site_id) {
      return NextResponse.json(
        { success: false, error: 'channel, to, message and site_id are required' },
        { status: 400 }
      );
    }

    const sendResult = await ChannelSendService.sendMessage({
      site_id,
      channel,
      to,
      message,
      subject,
      agent_id,
      conversation_id,
      lead_id,
      message_id,
    });

    if (!sendResult.success) {
      return NextResponse.json(
        { success: false, error: `Error sending message: ${sendResult.error}` },
        { status: 500 }
      );
    }

    if (conversation_id && message_id) {
      try {
        const { data: existing } = await supabaseAdmin
          .from('messages')
          .select('custom_data')
          .eq('id', message_id)
          .maybeSingle();

        await supabaseAdmin
          .from('messages')
          .update({
            custom_data: {
              ...((existing?.custom_data as Record<string, unknown>) || {}),
              source: channel,
              status: 'sent',
              provider_message_id: sendResult.messageId,
              sent_at: new Date().toISOString(),
            },
          })
          .eq('id', message_id);
      } catch (e) {
        console.warn('[sendChannelMessage] Failed to update message status:', e);
      }
    }

    return NextResponse.json({
      success: true,
      messageId: sendResult.messageId,
      delivered: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[sendChannelMessage] Unhandled error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
