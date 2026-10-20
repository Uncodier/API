import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-server';

export interface ZavuInboundHistory {
  siteId: string; userId?: string; channel: string; connectionId: string;
  senderId: string; from: string; message: string; originMessageId?: string;
}

/** History only: no lead guessing, assistant rows, workflows or provider calls. */
export async function persistDeniedZavuInbound(input: ZavuInboundHistory): Promise<void> {
  if (!input.userId || !input.originMessageId) return; // No safe owner/idempotency identity.
  const db = supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public',
  );
  const conversationId = uuidv5(JSON.stringify([
    'zavu-inbound-history', input.siteId, input.channel, input.senderId, input.from,
  ]), uuidv5.URL);
  const metadata = {
    source: 'zavu_inbound_message', channel: input.channel, channel_delivery: true,
    connection_id: input.connectionId, zavu_sender_id: input.senderId,
    zavu_from: input.from, automation_suppressed: true,
  };
  const { error: conversationError } = await db.from('conversations').upsert({
    id: conversationId, site_id: input.siteId, user_id: input.userId,
    channel: input.channel, status: 'active', title: 'Incoming channel messages', custom_data: metadata,
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (conversationError) throw new Error('Unable to preserve incoming conversation history');
  const { error: messageError } = await db.from('messages').upsert({
    id: uuidv5(JSON.stringify(['zavu-inbound-message', input.siteId, input.senderId, input.originMessageId]), uuidv5.URL),
    conversation_id: conversationId, user_id: input.userId, role: 'user', content: input.message,
    custom_data: { ...metadata, origin_message_id: input.originMessageId },
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (messageError) throw new Error('Unable to preserve incoming message history');
}