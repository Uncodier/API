import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-server';

export interface ZavuInboundHistory {
  siteId: string; userId?: string; channel: string; connectionId: string;
  senderId: string; from: string; message: string; originMessageId?: string; suppressionReason?: 'channel_unavailable' | 'license_check_unavailable';
}
export function deniedHistoryIds(input: ZavuInboundHistory) {
  return {
    conversationId: uuidv5(JSON.stringify(['zavu-inbound-history-v2', input.siteId, input.channel, input.connectionId, input.senderId, input.from]), uuidv5.URL),
    messageId: uuidv5(JSON.stringify(['zavu-inbound-message-v2', input.siteId, input.channel, input.connectionId, input.senderId, input.originMessageId]), uuidv5.URL),
  };
}

/** History only: ignoreDuplicates may match an older row. Verify its actual
 * provenance before reporting a saved turn; a primary key is not that proof. */
export async function persistDeniedZavuInbound(input: ZavuInboundHistory): Promise<{conversationId: string; messageId: string}> {
  if (!input.userId || !input.originMessageId) throw new Error('Incoming message history requires an owner and original message');
  const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
  // Older history IDs used only site/sender/message. Reuse a proven earlier
  // row, but do not let that key consume a different channel on the same sender.
  const oldId = uuidv5(JSON.stringify(['zavu-inbound-message', input.siteId, input.senderId, input.originMessageId]), uuidv5.URL);
  const old = await db.from('messages').select('id,role,conversation_id,content,custom_data').eq('id',oldId).maybeSingle();
  if (old.error) throw new Error('Unable to preserve incoming message history');
  const prior = old.data?.custom_data;
  let { conversationId, messageId } = deniedHistoryIds(input);
  if (old.data) {
    if (old.data.role !== 'user' || prior?.source !== 'zavu_inbound_message' || !prior.automation_suppressed
      || !prior.channel || !prior.connection_id || prior.zavu_sender_id !== input.senderId || prior.origin_message_id !== input.originMessageId) {
      throw new Error('Legacy inbound history has no verifiable source');
    }
    if (prior.channel === input.channel && prior.connection_id === input.connectionId) {
      if (prior.zavu_from !== input.from || old.data.content !== input.message || !old.data.conversation_id) {
        throw new Error('Legacy inbound history conflicts with the signed turn');
      }
      conversationId = old.data.conversation_id;
      messageId = oldId;
    }
  }
  const metadata = { source: 'zavu_inbound_message', channel: input.channel, channel_delivery: true,
    connection_id: input.connectionId, zavu_sender_id: input.senderId, zavu_from: input.from, automation_suppressed: true,
    suppression_reason: input.suppressionReason ?? 'channel_unavailable' };
  const { error: conversationError } = await db.from('conversations').upsert({ id: conversationId, site_id: input.siteId,
    user_id: input.userId, channel: input.channel, status: 'active', title: 'Incoming channel messages', custom_data: metadata,
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (conversationError) throw new Error('Unable to preserve incoming conversation history');
  const {data:thread, error:scopeError} = await db.from('conversations').select('id').eq('id',conversationId)
    .eq('site_id',input.siteId).eq('channel',input.channel).maybeSingle();
  if (scopeError || !thread) throw new Error('Incoming conversation scope changed');
  const { error: messageError } = await db.from('messages').upsert({ id: messageId, conversation_id: conversationId,
    user_id: input.userId, role: 'user', content: input.message, custom_data: { ...metadata, origin_message_id: input.originMessageId },
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (messageError) throw new Error('Unable to preserve incoming message history');
  const {data:row,error} = await db.from('messages').select('custom_data').eq('id',messageId)
    .eq('conversation_id',conversationId).eq('role','user').eq('content',input.message).maybeSingle();
  if (error || !row || row.custom_data?.origin_message_id !== input.originMessageId
    || Object.entries(metadata).some(([key,value])=>row.custom_data?.[key] !== value)) throw new Error('Incoming history does not match the original turn');
  return { conversationId, messageId };
}
