import { createHash } from 'node:crypto';
import { assertAutomationSendAllowed, AutomationSendSuppressed } from './automation-send-guard';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { stripMarkdownForSpeech } from './long-reply-audio';
import { validateResponseFormat } from './response-format';
import { requiresPlatformInferenceCredits, withCustomerOperation } from '@/lib/services/ai/customer-routing';

export class AudioDeliveryError extends Error {
  readonly status = 422;
}

interface AudioDeliveryParams {
  siteId: string;
  conversationId?: string;
  messageId?: string;
  channel: string;
  text: string;
  recipient: string;
  sender: string;
  dispatch: (audio: { audioUrl: string; mimeType: string }) => Promise<string>;
}

/** Only mark a definitely unstarted audio request failed; never rewrite a receipt. */
export async function markAudioPreflightFailed(params: {
  siteId: string; conversationId?: string; messageId?: string; reason?: string;
}): Promise<void> {
  if (!params.conversationId || !params.messageId) return;
  try {
    const { data: conversation, error: scopeError } = await supabaseAdmin.from('conversations')
      .select('id').eq('id', params.conversationId).eq('site_id', params.siteId).maybeSingle();
    if (scopeError || !conversation) return;
    const { data: row, error } = await supabaseAdmin.from('messages').select('custom_data, role')
      .eq('id', params.messageId).eq('conversation_id', params.conversationId).maybeSingle();
    if (error || !row || !['assistant', 'team_member'].includes(row.role) || row.custom_data?.audio_delivery || row.custom_data?.template_delivery
      || row.custom_data?.automation_skipped === true || row.custom_data?.response_format === 'text'
      || row.custom_data?.provider_message_id || row.custom_data?.needs_reconciliation === true
      || ['sent', 'delivered', 'read', 'sending', 'placement_unknown'].includes(row.custom_data?.status)) return;
    let query = supabaseAdmin.from('messages').update({ custom_data: {
      ...(row.custom_data || {}), response_format: 'audio', status: 'failed', command_status: 'failed',
      error_message: params.reason || 'Audio preparation or eligibility failed; no message was dispatched.',
    } }).eq('id', params.messageId).eq('conversation_id', params.conversationId);
    query = row.custom_data === null ? query.is('custom_data', null) : query.eq('custom_data', JSON.stringify(row.custom_data));
    await query;
  } catch { /* Preserve the original error; status uncertainty never authorizes a resend. */ }
}

/**
 * A persisted compare-and-set receipt owns generation and dispatch. An uncertain
 * outcome is never automatically resent, even if a Temporal activity is retried.
 * No leases expire into a new send: interrupted operations require reconciliation.
 */
export async function deliverExplicitAudio(params: AudioDeliveryParams): Promise<string> {
  const guard = () => assertAutomationSendAllowed({ site_id: params.siteId, conversation_id: params.conversationId,
    message_id: params.messageId, message: params.text });
  await guard();
  validateResponseFormat('audio', params.channel);
  if (!params.messageId || !params.conversationId) {
    throw new AudioDeliveryError('Audio delivery requires a saved message and conversation');
  }
  const { data: conversation, error: conversationError } = await supabaseAdmin.from('conversations')
    .select('id').eq('id', params.conversationId).eq('site_id', params.siteId).maybeSingle();
  if (conversationError || !conversation) throw new AudioDeliveryError('Audio conversation scope could not be verified');
  const { data: row, error } = await supabaseAdmin.from('messages')
    .select('id, content, role, custom_data').eq('id', params.messageId)
    .eq('conversation_id', params.conversationId).maybeSingle();
  if (error || !row || !['assistant', 'team_member'].includes(row.role)
    || typeof row.content !== 'string' || row.content.trim() !== params.text.trim()) {
    throw new AudioDeliveryError('Audio message changed or does not belong to this conversation');
  }
  const text = stripMarkdownForSpeech(params.text);
  if (!text || text.length > 4000) throw new AudioDeliveryError('Audio text must contain 1–4000 spoken characters');
  const key = createHash('sha256').update(JSON.stringify({
    text: params.text, channel: params.channel, to: params.recipient, sender: params.sender,
  })).digest('hex');
  let metadata = row.custom_data;
  if (metadata?.template_delivery) throw new AudioDeliveryError('Template already owns delivery; no audio was sent');
  if (metadata?.response_format !== undefined && metadata.response_format !== 'audio') {
    throw new AudioDeliveryError('Audio delivery conflicts with the saved response format');
  }
  let receipt = metadata?.audio_delivery;
  if (!receipt && (metadata?.provider_message_id || metadata?.needs_reconciliation === true
    || ['sending', 'sent', 'delivered', 'read', 'placement_unknown'].includes(metadata?.status))) {
    throw new AudioDeliveryError('Audio delivery may already have started; reconcile before retrying');
  }
  if (receipt && receipt.key !== key) throw new AudioDeliveryError('Audio delivery content or destination changed');
  if (['sent', 'delivered', 'read'].includes(receipt?.state) && typeof receipt.provider_message_id === 'string') return receipt.provider_message_id;
  if (receipt && receipt.state !== 'ready') {
    throw new AudioDeliveryError('Audio delivery is pending or unconfirmed; reconcile before retrying');
  }
  const persist = async (nextReceipt: Record<string, unknown>, extras: Record<string, unknown> = {}) => {
    let senderParts: unknown;
    try { senderParts = JSON.parse(params.sender); } catch { /* Legacy identity remains key-bound. */ }
    const identity = Array.isArray(senderParts) && senderParts[0] === 'audio-sender-v1' ? senderParts : [];
    const next = { ...(metadata || {}), ...extras, response_format: 'audio', audio_delivery: {
      ...nextReceipt, site_id: params.siteId, channel: params.channel, recipient: params.recipient,
      sender_identity: params.sender, provider: identity[1],
      ...(identity[1] === 'zavu' ? { sender_id: identity[2] } : {}),
      ...(metadata?.connection_id ? { connection_id: metadata.connection_id } : {}),
    } };
    let query = supabaseAdmin.from('messages').update({ custom_data: next })
      .eq('id', params.messageId!).eq('conversation_id', params.conversationId!).eq('content', row.content);
    query = metadata === null ? query.is('custom_data', null) : query.eq('custom_data', JSON.stringify(metadata));
    const { data: updated, error: updateError } = await query.select('id').maybeSingle();
    if (updateError || !updated) throw new AudioDeliveryError('Audio delivery ownership changed; check message status');
    metadata = next;
    receipt = next.audio_delivery;
  };
  if (!receipt) {
    const { CreditService } = await import('@/lib/services/billing/CreditService');
    const { synthesizeSpeech, validateSpeechOptions } = await import('@/lib/services/ai/tts-service');
    // Validate configuration before claiming and charging; synthesis is never
    // retried automatically after an ambiguous charged preparation attempt.
    const options = validateSpeechOptions({ text, format: 'mp3' });
    const credits = Math.max(0.01, text.length / 1000 * CreditService.PRICING.AUDIO_GENERATION_MINUTE);
    const platformInference = requiresPlatformInferenceCredits(params.siteId);
    if (platformInference && !await CreditService.validateCredits(params.siteId, credits)) throw new AudioDeliveryError('Insufficient audio credits');
    await persist({ key, state: 'preparing' });
    try {
      if (platformInference) await CreditService.deductCredits(params.siteId, credits, 'audio_generation', 'Audio message response', {
        message_id: params.messageId, channel: params.channel, text_length: text.length,
      });
      const { audio, mimeType } = await withCustomerOperation(`channel-audio:${params.messageId}:${key}`, () =>
        synthesizeSpeech({ text, provider: options.provider,
          format: 'mp3', voice: options.voice, model: options.deployment }));
      const path = `${params.siteId}/message_audio_${params.messageId}_${key}.mp3`;
      const { error: uploadError } = await supabaseAdmin.storage.from('assets').upload(path, audio, { contentType: mimeType });
      if (uploadError) throw new AudioDeliveryError('Audio upload failed');
      const { data: { publicUrl } } = supabaseAdmin.storage.from('assets').getPublicUrl(path);
      await guard();
      await persist({ key, state: 'ready', audioUrl: publicUrl, mimeType }, {
        attachments: [...(Array.isArray(metadata?.attachments) ? metadata.attachments : []),
          { url: publicUrl, mimeType, type: 'audio', name: 'Audio response.mp3' }],
      });
    } catch (error) {
      if (error instanceof AutomationSendSuppressed) throw error;
      await persist({ key, state: 'preparation_failed' }, { status: 'failed', command_status: 'failed' });
      throw new AudioDeliveryError('Audio preparation failed; no text was sent');
    }
  }
  const prepared = { audioUrl: receipt.audioUrl as string, mimeType: receipt.mimeType as string };
  await guard();
  await persist({ ...receipt, state: 'dispatching' }, { status: 'sending' });
  let providerMessageId: string;
  try {
    providerMessageId = await params.dispatch(prepared);
    if (!providerMessageId || providerMessageId === 'unknown') throw new Error('Missing provider receipt');
  } catch (error) {
    if (error instanceof AutomationSendSuppressed) throw error;
    await persist({ ...receipt, state: 'unknown' }, { status: 'placement_unknown' });
    throw new AudioDeliveryError('Audio delivery is unconfirmed; check the conversation before retrying');
  }
  // A webhook can win the CAS after the provider response. Reload, never replace
  // a stronger receipt with the stale dispatch snapshot or dispatch again.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await persist({ ...receipt, state: 'sent', provider_message_id: providerMessageId }, {
        status: 'sent', command_status: 'completed', provider_message_id: providerMessageId,
      });
      return providerMessageId;
    } catch (error) {
      const { data: fresh, error: readError } = await supabaseAdmin.from('messages').select('custom_data')
        .eq('id', params.messageId).eq('conversation_id', params.conversationId).eq('content', row.content).maybeSingle();
      const current = fresh?.custom_data?.audio_delivery;
      if (readError || !current || current.key !== key) throw error;
      if (current.provider_message_id === providerMessageId && ['sent', 'delivered', 'read', 'failed'].includes(current.state)) {
        if (current.state === 'failed') throw new AudioDeliveryError('Audio delivery failed at the provider; reconcile before retrying');
        return providerMessageId;
      }
      if (current.state !== 'dispatching' || current.provider_message_id) throw error;
      metadata = fresh.custom_data;
      receipt = current;
    }
  }
  throw new AudioDeliveryError('Audio receipt persistence is unconfirmed; reconcile before retrying');
}