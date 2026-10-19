import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { assertVoiceCallAllowed } from '@/lib/services/zavu/voice-call-service';
import { readToolExecutionContext, sanitizeToolContextText } from '@/lib/services/tool-execution-context';
import { loadExactAccount, type ExactDeliveryInput, type ExactDeliveryResult } from '@/lib/messaging/exact-delivery';
import { validateVoiceGuidance } from '../sendBulkMessages/voice-context';

export const isTrackedVoiceTest = (input: ExactDeliveryInput) => input.channel === 'voice' && input.voice_mode === 'agent_call';

/** Read-only admission. Run for every route before creating records or dispatching any route. */
export async function preflightPublishTest(input: ExactDeliveryInput): Promise<void> {
  await loadExactAccount(input.site_id, input.channel, input.connection_id);
  if (input.channel !== 'voice') return;
  await assertVoiceCallAllowed(input.site_id, input.lead_id, input.to);
  if (!isTrackedVoiceTest(input)) return;
  // A Send Test is not an opt-in mechanism. Do not inherit the legacy service's
  // allowance for unknown consent when initiating a new interactive test call.
  const { data, error } = await supabaseAdmin.from('leads')
    .select('voice_call_consent_status').eq('id', input.lead_id!).eq('site_id', input.site_id).maybeSingle();
  if (error || data?.voice_call_consent_status !== 'granted') {
    throw new Error('Voice agent test calls require explicit Voice call consent.');
  }
  const invalid = validateVoiceGuidance({ channel: input.channel, voiceMode: 'agent_call', greeting: input.message,
    objective: input.objective, additionalContext: input.additional_context });
  if (invalid) throw new Error(invalid);
  if (!input.message.trim()) throw new Error('Voice agent test greeting is required.');
}

/** IDs and ownership are server-created, never taken from tool/client arguments. */
export async function createTrackedVoiceTest(input: ExactDeliveryInput): Promise<ExactDeliveryInput> {
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const objective = sanitizeToolContextText(input.objective, 500);
  const additionalContext = sanitizeToolContextText(input.additional_context, 4_000);
  const executionContext = readToolExecutionContext(input.tool_execution_context, input.site_id);
  const customData = {
    source: 'publish_test', is_test: true, channel: 'voice', connection_id: input.connection_id, voice_mode: 'agent_call',
    // Never enter the approved-message queue, including a crash before dispatch.
    status: 'test_pending',
    ...(objective ? { voice_objective: objective } : {}),
    ...(additionalContext ? { voice_additional_context: additionalContext } : {}),
    ...(executionContext ? { tool_execution_context: executionContext } : {}),
  };
  const { error: conversationError } = await supabaseAdmin.from('conversations').insert({
    id: conversationId, site_id: input.site_id, lead_id: input.lead_id, channel: 'voice',
    title: input.subject || 'Voice agent test call', custom_data: customData,
  });
  if (conversationError) throw new Error('Failed to create Voice test conversation.');
  const { error: messageError } = await supabaseAdmin.from('messages').insert({
    id: messageId, conversation_id: conversationId, lead_id: input.lead_id, role: 'assistant',
    content: input.message, custom_data: customData,
  });
  if (messageError) {
    // Only delete our newly created, empty conversation. No provider was called.
    await supabaseAdmin.from('conversations').delete().eq('id', conversationId).eq('site_id', input.site_id);
    throw new Error('Failed to create tracked Voice test message.');
  }
  return { ...input, objective, additional_context: additionalContext, conversation_id: conversationId, message_id: messageId,
    // Revalidate explicit consent at the adapter's last pre-dispatch boundary;
    // a consent/account change after record creation must still never dial.
    before_dispatch: async () => { await preflightPublishTest(input); },
  };
}

/** The real tracked service owns provider outcomes; only fill an untouched admission failure. */
export async function settleVoiceTestFailure(input: ExactDeliveryInput, result: ExactDeliveryResult): Promise<void> {
  if (result.success || !input.message_id) return;
  const { data, error } = await supabaseAdmin.from('messages').select('custom_data')
    .eq('id', input.message_id).eq('conversation_id', input.conversation_id!).maybeSingle();
  if (error || data?.custom_data?.status !== 'test_pending') return;
  const status = result.delivery_attempted ? 'placement_unknown' : 'failed';
  await supabaseAdmin.from('messages').update({ custom_data: { ...data.custom_data, status, call_status: status,
    command_status: status === 'failed' ? 'failed' : 'pending' } })
    .eq('id', input.message_id).eq('custom_data', JSON.stringify(data.custom_data));
}