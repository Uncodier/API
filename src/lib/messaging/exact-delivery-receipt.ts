import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { deliveryError } from './exact-delivery-context';
import type { ExactDeliveryResult } from './exact-delivery';

/** Compare-and-set on the original metadata makes concurrent attempts fail closed. */
export async function claimExactDelivery(message: any, connectionId: string) {
  const data = message.custom_data || {};
  if (message.role !== 'assistant' || data.status !== 'sending') throw deliveryError('Message is not claimed for delivery.');
  if (data.exact_delivery_receipt) throw deliveryError('Delivery requires reconciliation before another provider attempt.');
  const attemptId = randomUUID();
  const receipt = { attempt_id: attemptId, connection_id: connectionId, state: 'attempting', at: new Date().toISOString() };
  const { data: claimed, error } = await supabaseAdmin.from('messages')
    .update({ custom_data: { ...data, exact_delivery_receipt: receipt } }).eq('id', message.id)
    .eq('conversation_id', message.conversation_id).eq('custom_data', JSON.stringify(data)).select('id').maybeSingle();
  if (error || !claimed) throw deliveryError('Delivery was already claimed or changed.');
  return attemptId;
}

/** Unknown acceptance is sticky: workers must never automatically retry another SMTP/Twilio send. */
export async function finishExactDelivery(messageId: string, attemptId: string, result: ExactDeliveryResult) {
  const { data: message, error } = await supabaseAdmin.from('messages').select('custom_data').eq('id', messageId).maybeSingle();
  if (error || !message || message.custom_data?.exact_delivery_receipt?.attempt_id !== attemptId) {
    throw deliveryError('Delivery receipt requires reconciliation.');
  }
  const previous = message.custom_data;
  const next = { ...previous, exact_delivery_receipt: { ...previous.exact_delivery_receipt,
    state: result.success ? 'accepted' : result.delivery_attempted ? 'unknown' : 'rejected',
    ...(result.success ? { result } : {}), at: new Date().toISOString() } };
  // A rejected preparation did not invoke a provider and is safe to retry after fixing configuration.
  if (!result.success && !result.delivery_attempted) delete next.exact_delivery_receipt;
  if (result.success) {
    next.status = result.callId ? previous.status : 'sent';
    next.provider_message_id = result.messageId;
    next.sent_at = new Date().toISOString();
    if (result.agentmail_message_id) {
      next.agentmail_message_id = result.agentmail_message_id;
      next.agentmail_thread_id = result.agentmail_thread_id;
      next.agentmail_inbox_id = result.agentmail_inbox_id;
    }
  }
  const { error: updateError, data: updated } = await supabaseAdmin.from('messages').update({ custom_data: next })
    .eq('id', messageId).eq('custom_data', JSON.stringify(previous)).select('id').maybeSingle();
  if (updateError || !updated) throw deliveryError('Delivery receipt update requires reconciliation.');
}