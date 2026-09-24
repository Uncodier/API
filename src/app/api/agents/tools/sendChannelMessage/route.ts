import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';
import { assertVoiceCallAllowed } from '@/lib/services/zavu/voice-call-service';
import { bindLocalOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';
import { canAccessSite } from '@/lib/security/site-access';

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
    if (!await canAccessSite(request, site_id)) {
      return NextResponse.json(
        { success: false, error: 'Site access denied' },
        { status: 403 },
      );
    }

    if (String(channel).toLowerCase() === 'voice') {
      await assertVoiceCallAllowed(site_id, lead_id, to);
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

    const normalizedChannel = String(channel).toLowerCase();
    if (
      normalizedChannel === 'instagram'
      && conversation_id
      && message_id
      && sendResult.messageId
    ) {
      try {
        const { data: conversation } = await supabaseAdmin
          .from('conversations')
          .select('custom_data')
          .eq('id', conversation_id)
          .maybeSingle();
        const outstandConversationId =
          conversation?.custom_data?.outstand_conversation_id;
        if (typeof outstandConversationId !== 'string') {
          throw new Error('Outstand conversation metadata was not found');
        }
        await bindLocalOutstandMessage({
          localMessageId: message_id,
          localConversationId: conversation_id,
          outstandConversationId,
          outstandMessageId: sendResult.messageId,
        });
      } catch (error) {
        console.warn('[sendChannelMessage] Failed to bind Outstand message:', error);
      }
    } else if (conversation_id && message_id) {
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
      delivered: normalizedChannel !== 'instagram',
      status: normalizedChannel === 'instagram' ? 'pending' : 'sent',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[sendChannelMessage] Unhandled error:', error);
    const status =
      error && typeof error === 'object' && 'status' in error
      && typeof error.status === 'number'
        ? error.status
        : 500;
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status }
    );
  }
}
