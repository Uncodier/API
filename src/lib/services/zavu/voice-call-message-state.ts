import { supabaseAdmin } from '@/lib/database/supabase-server';
import type { ZavuVoiceCall } from './voice-call-client';

export type VoicePlacementStatus = 'failed' | 'placement_unknown';

export class VoicePlacementError extends Error {
  readonly status: number;

  constructor(error: unknown, readonly deliveryStatus: VoicePlacementStatus) {
    super(error instanceof Error ? error.message : 'Voice call placement failed');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'VoicePlacementError';
    this.status = error && typeof error === 'object' && 'status' in error
      && typeof error.status === 'number' ? error.status : 502;
  }
}

export function voiceCommandStatus(status: unknown): 'pending' | 'success' | 'failed' {
  if (status === 'failed') return 'failed';
  if (status === 'sent' || status === 'received') return 'success';
  return 'pending';
}

async function readMessageData(messageId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin.from('messages')
    .select('custom_data').eq('id', messageId).maybeSingle();
  if (error || !data) throw new Error('Failed to read Voice call message state');
  return data.custom_data && typeof data.custom_data === 'object' ? data.custom_data : null;
}

export async function markMessagePlaced(
  messageId: string,
  call: ZavuVoiceCall,
  deliveryId: string,
): Promise<void> {
  const original = await readMessageData(messageId);
  const customData = original || {};
  const preserveTerminal = customData.provider_call_id === call.id
    && ['completed', 'failed', 'busy', 'no_answer', 'canceled', 'cancelled']
      .includes(String(customData.call_status));
  const failed = ['failed', 'busy', 'no_answer', 'canceled', 'cancelled'].includes(call.status);
  const status = preserveTerminal ? customData.status : failed ? 'failed' : 'sent';
  let query = supabaseAdmin.from('messages').update({
    custom_data: {
      ...customData,
      status,
      command_status: voiceCommandStatus(status),
      voice_mode: 'agent_call',
      voice_call_delivery_id: deliveryId,
      provider_call_id: call.id,
      call_status: preserveTerminal ? customData.call_status : call.status,
      sent_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }).eq('id', messageId);
  query = original === null ? query.is('custom_data', null) : query.eq('custom_data', JSON.stringify(original));
  const { data: updated, error } = await query.select('id').maybeSingle();
  if (error || !updated) throw new Error('Placed Voice call message state requires reconciliation');
}

export async function markMessagePlacementError(
  messageId: string,
  status: VoicePlacementStatus,
  error: unknown,
): Promise<void> {
  const original = await readMessageData(messageId);
  const customData = original || {};
  // A callback or an earlier ambiguous attempt is stronger evidence than a
  // preflight rejection. Never turn that evidence into a retryable failure.
  if (customData.provider_call_id || (status === 'failed'
    && ['placement_unknown', 'placing', 'queued', 'ringing', 'in_progress']
      .includes(String(customData.call_status)))) {
    throw new VoicePlacementError('Existing Voice call state requires reconciliation', 'placement_unknown');
  }
  let query = supabaseAdmin.from('messages').update({
    custom_data: {
      ...customData,
      status,
      command_status: status === 'failed' ? 'failed' : 'pending',
      voice_mode: 'agent_call',
      call_status: status,
      error_message: error instanceof Error ? error.message : 'Voice call placement failed',
    },
    updated_at: new Date().toISOString(),
  }).eq('id', messageId);
  query = original === null ? query.is('custom_data', null) : query.eq('custom_data', JSON.stringify(original));
  const { data: updated, error: updateError } = await query.select('id').maybeSingle();
  if (updateError || !updated) throw new Error('Failed to persist Voice call placement state');
}