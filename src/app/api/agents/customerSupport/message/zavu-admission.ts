import { NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { admitZavuInboundAutomation } from '@/lib/services/zavu/inbound-message-license';
import { ResourceLicenseError } from '@/lib/billing/licensed-resources';

/** Reauthorize the pinned webhook destination after Temporal/context preparation. */
export async function checkZavuSupportAdmission(request: Request, body: any) {
  const metadata = body.custom_data;
  if (metadata?.source !== 'zavu_inbound_message') return;
  if (!isInternalServiceRequest(request)) {
    return NextResponse.json({ success: false, error: 'Internal channel ingestion required' }, { status: 403 });
  }
  if (typeof metadata.connection_id !== 'string' || !metadata.connection_id
    || typeof metadata.zavu_sender_id !== 'string' || !metadata.zavu_sender_id
    || typeof metadata.zavu_from !== 'string' || typeof body.origin !== 'string') {
    return NextResponse.json({ success: false, error: 'Invalid channel ingestion identity' }, { status: 400 });
  }
  try {
    const input = {
      siteId: body.site_id, userId: body.userId, channel: body.origin,
      connectionId: metadata.connection_id, senderId: metadata.zavu_sender_id,
      from: metadata.zavu_from, message: body.message, originMessageId: body.origin_message_id,
    };
    let receipt: { conversationId: string; messageId: string } | undefined;
    if (!await admitZavuInboundAutomation(input, saved => { receipt = saved; })) {
      if (!receipt) throw new Error('Suppressed inbound history was not confirmed');
      const { conversationId, messageId } = receipt;
      return NextResponse.json({ success: true, skipped: 'channel_unavailable', conversation_id: conversationId,
        messages: { user: { message_id: messageId } } });
    }
  } catch (error) {
    if (!(error instanceof ResourceLicenseError)) throw error;
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
}