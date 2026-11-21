import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';
import { assertVoiceCallAllowed } from '@/lib/services/zavu/voice-call-service';
import { bindLocalOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';
import { canAccessSite } from '@/lib/security/site-access';
import { validateResponseFormat } from '@/lib/services/channels/response-format';
import { validateOutboundMedia } from '@/lib/services/channels/outbound-media';

/**
 * Sends an outbound message on a connected channel (telegram, messenger).
 */
export async function POST(request: NextRequest) {
  try {
    let payload;
    try { payload = await request.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: 'Expected a message object' }, { status: 400 });
    }
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
      response_format,
      message_type,
      media_url,
      mime_type,
    } = payload;

    try { validateResponseFormat(response_format, channel); }
    catch { return NextResponse.json({ success: false, error: 'Invalid response format for this channel' }, { status: 400 }); }

    if (![channel, to, site_id].every(value => typeof value === 'string' && value.trim())) {
      return NextResponse.json(
        { success: false, error: 'channel, to and site_id are required' },
        { status: 400 }
      );
    }
    if (!await canAccessSite(request, site_id)) {
      return NextResponse.json(
        { success: false, error: 'Site access denied' },
        { status: 403 },
      );
    }

    const media = await validateOutboundMedia({ message_type, media_url, mime_type, response_format }, channel);
    if ((message !== undefined && typeof message !== 'string') || (!message?.trim() && !media)) {
      return NextResponse.json({ success: false, error: 'message or media is required' }, { status: 400 });
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
      response_format,
      message_type,
      media_url,
      mime_type,
      ...(payload.custom_data?.source === 'zavu_inbound_message' ? { expectedZavuTurn: {
        connectionId: payload.custom_data.connection_id, senderId: payload.custom_data.zavu_sender_id,
        from: payload.custom_data.zavu_from, channel: payload.custom_data.channel, eventId: payload.custom_data.origin_message_id,
      } } : {}),
    });

    if (!sendResult.success) {
      return NextResponse.json(
        { success: false, error: `Error sending message: ${sendResult.error}` },
        { status: sendResult.status || 500 }
      );
    }
    if (sendResult.skipped) return NextResponse.json({ ...sendResult, status: 'skipped', delivered: false });
    if (sendResult.templateDelivery) {
      return NextResponse.json({ ...sendResult.templateDelivery, delivered: false,
        timestamp: new Date().toISOString() }, { status: sendResult.templateDelivery.template_pending ? 202 : 200 });
    }

    // Comment delivery owns its compare-and-set receipt and must retain source/target metadata.
    if (sendResult.deliveryKind === 'comment') return NextResponse.json({
      success: true, messageId: sendResult.messageId, delivered: true, status: 'sent',
      timestamp: new Date().toISOString(),
    });
    if (
      sendResult.provider === 'outstand'
      && conversation_id
      && message_id
      && sendResult.messageId
    ) {
      try {
        const { data: conversation } = await supabaseAdmin
          .from('conversations')
          .select('custom_data')
          .eq('id', conversation_id).eq('site_id', site_id)
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
    } else if (!sendResult.receiptHandled && conversation_id && message_id && response_format !== 'audio' && !media) {
      try {
        const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
        const { data: existing, error } = await db
          .from('messages')
          .select('custom_data')
          .eq('id', message_id).eq('conversation_id', conversation_id)
          .maybeSingle();
        if (error || !existing) throw new Error('Saved delivery receipt is unavailable');
        const previous = existing.custom_data;
        const update = db
          .from('messages')
          .update({
            custom_data: {
              ...(previous || {}),
              source: channel,
              status: sendResult.providerStatus ?? 'sent',
              provider_message_id: sendResult.messageId,
              sent_at: new Date().toISOString(),
            },
          })
          .eq('id', message_id).eq('conversation_id', conversation_id);
        // Do not overwrite a newer provider receipt or a concurrent human update.
        const result = await (previous == null ? update.is('custom_data', null) : update.eq('custom_data', JSON.stringify(previous)))
          .select('id').maybeSingle();
        if (result.error || !result.data) throw new Error('Saved delivery receipt changed');
      } catch (e) {
        console.warn('[sendChannelMessage] Failed to update message status:', e);
      }
    }

    return NextResponse.json({
      success: true,
      messageId: sendResult.messageId,
      ...(sendResult.accepted === true ? { accepted: true } : {}),
      delivered: sendResult.delivered === true,
      status: sendResult.providerStatus ?? (sendResult.provider === 'outstand' ? 'pending' : 'sent'),
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
