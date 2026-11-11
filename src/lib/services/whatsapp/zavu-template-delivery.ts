import { createHash } from 'node:crypto';
import { assertAutomationSendAllowed } from '@/lib/services/channels/automation-send-guard';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { requireLicensedChannel } from '@/lib/billing/licensed-resources';
import { loadSiteTemplateLanguage } from './template-language';
import { createZavuTemplate, getZavuTemplate, submitZavuTemplate, sendZavuTemplate, type ZavuTemplate } from '@/lib/services/zavu/templates';

export interface TemplateDeliveryResult {
  success: true;
  delivery_format: 'template';
  requested_response_format: 'audio';
  template_used: boolean;
  template_pending: boolean;
  status: 'template_pending' | 'sent';
  message_id?: string;
  messageId?: string;
  template_id: string;
  retry_after_seconds?: number;
}
export class TemplateDeliveryError extends Error {
  readonly status = 422;
}
interface Input {
  siteId: string; conversationId?: string; messageId?: string; text: string;
  recipient: string; connectionId: string; senderId: string;
}

/** The same saved row owns either audio or template, never two dispatches. */
export async function deliverZavuTemplate(input: Input): Promise<TemplateDeliveryResult> {
  const guard = () => assertAutomationSendAllowed({ site_id: input.siteId, conversation_id: input.conversationId,
    message_id: input.messageId, message: input.text });
  await guard();
  if (!input.messageId || !input.conversationId) throw new TemplateDeliveryError('Template fallback requires a saved message');
  const { data: conversation, error: scopeError } = await supabaseAdmin.from('conversations').select('id')
    .eq('id', input.conversationId).eq('site_id', input.siteId).maybeSingle();
  if (scopeError || !conversation) throw new TemplateDeliveryError('Template conversation scope is unavailable');
  const { data: message, error } = await supabaseAdmin.from('messages').select('content, role, custom_data')
    .eq('id', input.messageId).eq('conversation_id', input.conversationId).maybeSingle();
  if (error || !message || !['assistant', 'team_member'].includes(message.role) || message.content !== input.text) {
    throw new TemplateDeliveryError('Template message changed or is unavailable');
  }
  let metadata = message.custom_data;
  if (metadata?.audio_delivery) throw new TemplateDeliveryError('Audio already owns delivery; no template was sent');
  if (metadata?.response_format !== 'audio') throw new TemplateDeliveryError('Template fallback requires the saved audio selection');
  const fingerprint = createHash('sha256').update(JSON.stringify([input.text, input.recipient, input.senderId, input.connectionId])).digest('hex');
  let receipt: any = metadata?.template_delivery;
  if (receipt && receipt.key !== fingerprint) throw new TemplateDeliveryError('Template content or destination changed');
  const result = (pending: boolean): TemplateDeliveryResult => ({ success: true, delivery_format: 'template',
    requested_response_format: 'audio', template_used: !pending, template_pending: pending,
    status: pending ? 'template_pending' : 'sent', template_id: receipt.template_id,
    ...(pending ? { message_id: input.messageId, retry_after_seconds: 60 }
      : { message_id: receipt.provider_message_id, messageId: receipt.provider_message_id }) });
  if (receipt && (metadata.status === 'failed' || receipt.delivery_status === 'failed')) {
    throw new TemplateDeliveryError('Template delivery failed; no automatic resend is allowed');
  }
  if (['accepted', 'sent', 'delivered', 'read'].includes(receipt?.state) && receipt.provider_message_id) return result(false);
  const persist = async (next: any, extras: Record<string, unknown> = {}) => {
    const updated = { ...(metadata || {}), ...extras, requested_response_format: 'audio', delivery_format: 'template',
      template_delivery: next };
    const { data, error: writeError } = await supabaseAdmin.from('messages').update({ custom_data: updated })
      .eq('id', input.messageId!).eq('conversation_id', input.conversationId!).eq('content', input.text)
      .eq('custom_data', JSON.stringify(metadata)).select('id').maybeSingle();
    if (writeError || !data) throw new TemplateDeliveryError('Template delivery ownership changed; check the message status');
    metadata = updated; receipt = next;
  };
  const fail = async (state: string, reason: string) => {
    await persist({ ...receipt, state, reason }, { status: state === 'unknown' ? 'placement_unknown' : 'failed',
      command_status: 'failed', error_message: reason });
    throw new TemplateDeliveryError(reason);
  };
  try { await requireLicensedChannel(input.siteId, 'whatsapp', input.connectionId, input.senderId); }
  catch {
    if (receipt && ['ready', 'pending'].includes(receipt.state)) return fail('rejected', 'Selected WhatsApp sender is no longer available');
    throw new TemplateDeliveryError('Selected WhatsApp sender is unavailable');
  }
  if (!receipt) {
    const language = await loadSiteTemplateLanguage(input.siteId);
    // Literal content only. Never truncate, inject variables, translate silently,
    // or relabel an audio file as a Meta-compatible template header.
    if (!input.text.trim() || input.text.length > 1024 || /\{\{|\}\}|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)) {
      throw new TemplateDeliveryError('Template fallback requires 1–1024 characters of final text without unresolved variables');
    }
    const name = `reply_${createHash('sha256').update(JSON.stringify([input.siteId, input.messageId, fingerprint, language])).digest('hex').slice(0, 40)}`;
    await persist({ key: fingerprint, name, language, body: input.text, state: 'creating', started_at: new Date().toISOString() },
      { status: 'queued', command_status: 'pending' });
    let created: ZavuTemplate;
    try { created = await createZavuTemplate({ name, language, body: input.text }); }
    catch { return fail('unknown', 'Template creation is unconfirmed; reconcile before retrying'); }
    if (created.name !== name || created.body !== input.text || created.language !== language || created.status !== 'draft') {
      return fail('rejected', 'Template provider content or language does not match');
    }
    await persist({ ...receipt, template_id: created.id, state: 'ready' });
  }
  if (!['ready', 'pending'].includes(receipt.state)) throw new TemplateDeliveryError('Template is rejected, active, or unconfirmed; check its status');
  const deadlinePassed = Date.now() - Date.parse(receipt.started_at) > 24 * 60 * 60 * 1000;
  let current: ZavuTemplate;
  try { current = await getZavuTemplate(receipt.template_id); }
  catch { return result(true); } // Read-only polling failure: safe to retry, never dispatch.
  if (current.id !== receipt.template_id || current.name !== receipt.name || current.body !== receipt.body || current.language !== receipt.language) {
    return fail('rejected', 'Template content or language changed before delivery');
  }
  if (current.status === 'rejected' || current.whatsapp?.status?.toLowerCase() === 'rejected') return fail('rejected', 'WhatsApp rejected the template; no message was sent');
  // Always inspect the provider first: an approval obtained before the final
  // poll must not be discarded merely because our local deadline elapsed.
  const approved = current.status === 'approved' && (!current.whatsapp?.status || current.whatsapp.status.toLowerCase() === 'approved');
  if (deadlinePassed && !approved) return fail('rejected', 'Template approval timed out; no message was sent');
  if (current.status === 'draft') {
    if (receipt.state !== 'ready') return result(true);
    await persist({ ...receipt, state: 'submitting' });
    try { await submitZavuTemplate(receipt.template_id, input.senderId); }
    catch { return fail('unknown', 'Template submission is unconfirmed; reconcile before retrying'); }
    await persist({ ...receipt, state: 'pending', submitted_sender_id: input.senderId }, { status: 'queued', command_status: 'pending' });
    return result(true);
  }
  if (current.status !== 'approved') {
    if (receipt.state !== 'pending') await persist({ ...receipt, state: 'pending' });
    return result(true);
  }
  if (receipt.submitted_sender_id !== input.senderId) return fail('rejected', 'Template approval is not bound to the selected sender');
  if (current.whatsapp?.status && current.whatsapp.status.toLowerCase() !== 'approved') return result(true);
  try { await requireLicensedChannel(input.siteId, 'whatsapp', input.connectionId, input.senderId); }
  catch { return fail('rejected', 'Selected WhatsApp sender changed before template dispatch'); }
  await guard();
  await persist({ ...receipt, state: 'dispatching', sender_id: input.senderId, recipient: input.recipient,
    connection_id: input.connectionId }, { status: 'sending', command_status: 'pending' });
  let providerId: string;
  try { providerId = await sendZavuTemplate({ to: input.recipient, senderId: input.senderId,
    templateId: receipt.template_id, idempotencyKey: `template-fallback:${input.siteId}:${input.messageId}` }); }
  catch { return fail('unknown', 'Template delivery is unconfirmed; check provider status before retrying'); }
  await persist({ ...receipt, state: 'accepted', delivery_status: 'queued', provider_message_id: providerId }, {
    status: 'queued', command_status: 'pending', provider_message_id: providerId, accepted_at: new Date().toISOString(), needs_reconciliation: false,
    template_used: true, error_message: null,
  });
  return result(false);
}