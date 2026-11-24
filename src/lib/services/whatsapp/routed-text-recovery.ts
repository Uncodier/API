import { supabaseAdmin } from '@/lib/database/supabase-client';
import { matchesZavuThread } from '@/lib/services/channels/zavu-thread-scope';
import type { RoutedIdentity } from './routed-text-store';

/** DB only. Recovery must work even when a contact, license or provider changed.
 * No call to a send adapter or to the automation guard (the latter can write). */
type Data = Record<string, any>;
const field = 'whatsapp_text_delivery';
const present = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 200 && !/^(unknown|undefined|null|pending)$/i.test(value);
export type PendingBinding = { attempt_id: string; provider: 'zavu' | 'twilio'; connection_id: string; template_id: string };

async function readRow(id: RoutedIdentity) {
  const { data, error } = await supabaseAdmin.from('messages')
    .select('id,role,custom_data,conversations!inner(site_id,channel,custom_data)')
    .eq('id', id.message_id).eq('conversation_id', id.conversation_id).eq('conversations.site_id', id.site_id)
    .in('role', ['assistant', 'team_member']).maybeSingle();
  if (error) throw new Error('WhatsApp receipt store unavailable');
  const c = data?.conversations as unknown as Data | null;
  if (!data || !c || c.site_id !== id.site_id || !matchesZavuThread(c.channel ?? c.custom_data?.channel ?? c.custom_data?.source, c.custom_data, 'whatsapp')) {
    throw new Error('Scoped WhatsApp receipt unavailable');
  }
  return data.custom_data as Data | null;
}

function storedOutcome(id: RoutedIdentity, data: Data | null) {
  const stop = { message_id: id.message_id, status: 'needs_reconciliation' as const, success: false };
  if (!data) return stop;
  const receipt = data[field];
  if (data.automation_skipped && data.status === 'skipped') return { message_id: id.message_id, status: 'skipped' as const, success: true, skipped: true };
  if (data.exact_delivery_receipt || data.audio_delivery || data.template_delivery || data.pinned_text_delivery || data.native_media_delivery) return stop;
  if (!receipt) {
    if (data.status === 'failed' && data.command_status === 'failed' && data.error_code === 'WHATSAPP_RECIPIENT_UNVERIFIED'
      && !data.provider_message_id && !data.twilio_message_id && !data.external_message_id) {
      return { message_id: id.message_id, status: 'failed' as const, success: false, reason: 'Recipient verification is required.' };
    }
    return stop;
  }
  const route = receipt.route;
  const bound = route && ['zavu', 'twilio'].includes(route.provider) && present(route.connectionId);
  const binding = bound ? { connection_id: route.connectionId as string, provider: route.provider as 'zavu' | 'twilio' } : {};
  // The HTTP timeout may expire before the owning handler finishes. Do not
  // mark that attempt or declare polling finished: it can still publish a
  // queued template or accepted ID. The only authorized operation is another GET.
  if (receipt.state === 'attempting' && data.status === 'placement_unknown' && bound && present(receipt.attempt_id)
    && !receipt.provider_message_id && !data.provider_message_id && !data.twilio_message_id) {
    return { ...stop, ...binding, attempt_id: receipt.attempt_id as string, recovery_action: 'observe' as const };
  }
  if (receipt.state === 'accepted' && bound && present(receipt.provider_message_id) && receipt.provider_message_id !== id.message_id
    && data.provider_message_id === receipt.provider_message_id && ['queued', 'sending', 'sent', 'delivered', 'read', 'failed'].includes(data.status)) {
    const failed = data.status === 'failed' || receipt.delivery_status === 'failed';
    return { ...binding, message_id: id.message_id, status: failed ? 'failed' as const : 'accepted' as const,
      success: !failed, provider_message_id: receipt.provider_message_id as string };
  }
  if (receipt.state === 'failed' && data.status === 'failed') return { ...binding, message_id: id.message_id, status: 'failed' as const, success: false };
  if (receipt.state === 'pending' && data.status === 'queued' && bound && !data.needs_reconciliation
    && !data.provider_message_id && !data.twilio_message_id && !receipt.provider_message_id && present(receipt.attempt_id) && present(receipt.template?.id)) {
    return { ...binding, message_id: id.message_id, status: 'template_pending' as const, success: true,
      attempt_id: receipt.attempt_id as string, template_id: receipt.template.id as string };
  }
  return { ...stop, reconciliation_persisted: receipt.state === 'unknown' && data.status === 'needs_reconciliation' && data.needs_reconciliation === true };
}

export async function readRoutedTextOutcome(id: RoutedIdentity) { return storedOutcome(id, await readRow(id)); }

/** Stop only the exact idle poll observed by the reader. Never replace an in-flight
 * claim or a webhook result. Retrying this control action cannot dispatch. */
export async function stopRoutedTextPoll(id: RoutedIdentity, expected: PendingBinding) {
  const data = await readRow(id);
  const observed = storedOutcome(id, data);
  if (!data || observed.status !== 'template_pending') return observed;
  if (observed.provider !== expected.provider || observed.connection_id !== expected.connection_id
    || observed.template_id !== expected.template_id || observed.attempt_id !== expected.attempt_id) {
    return { message_id: id.message_id, status: 'needs_reconciliation' as const, success: false, reconciliation_persisted: false };
  }
  const reason = 'WhatsApp polling stopped; verify the saved receipt before retrying.';
  const updated = { ...data, status: 'needs_reconciliation', command_status: 'pending', needs_reconciliation: true, error_message: reason,
    [field]: { ...data[field], state: 'unknown', reason } };
  const { data: saved, error } = await supabaseAdmin.from('messages').update({ custom_data: updated })
    .eq('id', id.message_id).eq('conversation_id', id.conversation_id).eq('custom_data', JSON.stringify(data)).select('id').maybeSingle();
  if (error || !saved) throw new Error('WhatsApp receipt changed during reconciliation');
  return { message_id: id.message_id, status: 'needs_reconciliation' as const, success: false, reason, reconciliation_persisted: true };
}