import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { DeliveryChannel } from './delivery-routing';

export interface ExactDeliveryIdentity {
  site_id: string;
  channel: DeliveryChannel;
  connection_id?: string;
  lead_id?: string;
  conversation_id?: string;
  message_id?: string;
}

export function deliveryError(message: string, code = 'EXACT_DELIVERY_INVALID') {
  return Object.assign(new Error(message), { code, status: 409 });
}

const hasConnection = (data: any) => data && Object.prototype.hasOwnProperty.call(data, 'connection_id');

/** Stored message selection overrides conversation defaults, including invalid selections. */
export async function loadExactDeliveryContext(input: ExactDeliveryIdentity) {
  let message: any;
  let conversation: any;
  let lead: any;
  if (input.message_id) {
    const result = await supabaseAdmin.from('messages').select('*').eq('id', input.message_id).maybeSingle();
    if (result.error || !result.data) throw deliveryError('Delivery message is unavailable.');
    message = result.data;
    if (!message.conversation_id || (input.conversation_id && input.conversation_id !== message.conversation_id)) {
      throw deliveryError('Delivery conversation does not match the message.');
    }
  }
  const conversationId = message?.conversation_id || input.conversation_id;
  if (conversationId) {
    const result = await supabaseAdmin.from('conversations').select('*')
      .eq('id', conversationId).eq('site_id', input.site_id).maybeSingle();
    if (result.error || !result.data || result.data.site_id !== input.site_id) {
      throw deliveryError('Delivery conversation is unavailable for this site.');
    }
    conversation = result.data;
  }
  const customData = message?.custom_data || {};
  const storedData = hasConnection(customData) ? customData
    : hasConnection(conversation?.custom_data) ? conversation.custom_data : undefined;
  const connectionId = storedData ? storedData.connection_id : input.connection_id;
  if (storedData && input.connection_id !== undefined && input.connection_id !== connectionId) {
    throw deliveryError('Delivery selection conflicts with the stored message.');
  }
  if (connectionId !== undefined && (typeof connectionId !== 'string' || !connectionId.trim())) {
    throw deliveryError('Stored delivery connection is invalid.');
  }
  const storedChannel = customData.channel || conversation?.channel || conversation?.custom_data?.channel;
  if (connectionId !== undefined && storedChannel && storedChannel !== input.channel) {
    throw deliveryError('Delivery channel conflicts with the stored message.');
  }
  const leadId = message?.lead_id || conversation?.lead_id || input.lead_id;
  if (leadId && input.lead_id && input.lead_id !== leadId) throw deliveryError('Delivery lead does not match.');
  if (leadId) {
    const result = await supabaseAdmin.from('leads').select('*')
      .eq('id', leadId).eq('site_id', input.site_id).maybeSingle();
    if (result.error || !result.data) throw deliveryError('Delivery lead is unavailable for this site.');
    lead = result.data;
  }
  return { message, conversation, lead, customData, connectionId, conversationId, leadId, hasStoredConnection: !!storedData };
}