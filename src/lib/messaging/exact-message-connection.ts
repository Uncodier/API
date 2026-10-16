import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveDeliveryAccount, type DeliveryChannel } from './delivery-routing';
import { deliveryError } from './exact-delivery-context';

/** Bind worker prepare/result to persisted outbound identity, never a request-supplied sender. */
export async function resolveExactMessageConnection(siteId: string, channel: string, channels: unknown,
  messageId: string, conversationId?: string): Promise<{ present: boolean; connectionId?: string }> {
  const { data: message, error } = await supabaseAdmin.from('messages')
    .select('conversation_id,role,custom_data').eq('id', messageId).maybeSingle();
  if (error) throw error;
  if (!message) return { present: false };
  const { data: conversation, error: conversationError } = await supabaseAdmin.from('conversations')
    .select('site_id,channel,custom_data').eq('id', message.conversation_id).eq('site_id', siteId).maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation || conversation.site_id !== siteId || (conversationId && conversationId !== message.conversation_id)) {
    throw deliveryError('Channel message identity does not belong to this site.');
  }
  const has = (data: any) => data && Object.prototype.hasOwnProperty.call(data, 'connection_id');
  const selected = has(message.custom_data) ? message.custom_data : has(conversation.custom_data) ? conversation.custom_data : undefined;
  if (!selected) return { present: false };
  const connectionId = selected.connection_id;
  if (typeof connectionId !== 'string' || !connectionId || (conversation.channel && conversation.channel !== channel)
    || (message.custom_data?.channel && message.custom_data.channel !== channel)) {
    throw deliveryError('Stored channel delivery selection is invalid.');
  }
  resolveDeliveryAccount(channels, { channel: channel as DeliveryChannel, connection_id: connectionId });
  return { present: true, connectionId };
}