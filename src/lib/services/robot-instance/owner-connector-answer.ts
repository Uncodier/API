import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { confirmDirectResultRelease } from '@/lib/connectors/provider-direct-receipt';
import { redactUserText } from '@/lib/harness/security';
import { assistantRuntimeProvenance } from './assistant-context-version';
import { RecoveryError, type AssistantRecoveryScope } from './assistant-recovery-schema';
import { z } from 'zod';

const followupSchema = z.union([
  z.object({ source_id: z.string().uuid(), answer: z.string().min(1).max(65_536) }).strict(),
  z.object({ unavailable: z.literal(true) }).strict(),
]);

export async function loadOwnerConnectorFollowup(scope: AssistantRecoveryScope) {
  try {
    const {data,error} = await supabaseAdmin.rpc('connector_ask_followup', {
      p_action_id: scope.userMessageLogId,
    }).abortSignal(AbortSignal.timeout(5000));
    // Rolling deploy: a database without the follow-up RPC retains the old behavior.
    if (error?.code === 'PGRST202' || error?.code === '42883') return undefined;
    if (error) throw error;
    return data === null ? undefined : followupSchema.parse(data);
  } catch { throw new RecoveryError('inactive'); }
}

function answerText(text: string) {
  const answer = redactUserText(text).trim();
  if (!answer || Buffer.byteLength(answer) > 65_536 || answer.includes('\0')) throw new RecoveryError('invalid_state');
  return answer;
}

function answerLink(scope: AssistantRecoveryScope) {
  return `This answer uses private connector data. [Open your answer](/robots/private-answer/${scope.userMessageLogId}).`;
}

export async function publishOwnerConnectorFollowup(scope: AssistantRecoveryScope, sourceId: string, text: string) {
  const answer = answerText(text);
  try {
    const {data,error} = await supabaseAdmin.rpc('connector_ask_followup', {
      p_action_id: scope.userMessageLogId, p_source_id: sourceId, p_answer: answer,
    }).abortSignal(AbortSignal.timeout(5000));
    if (error || data !== true) throw new RecoveryError('conflict');
  } catch { throw new RecoveryError('conflict'); }
  return answerLink(scope);
}

export async function confirmOwnerConnectorContext(claimIds: readonly string[]) {
  try {
    // One active action row is locked by each release check; avoid racing it.
    for (const id of claimIds) await confirmDirectResultRelease(id);
  } catch { throw new RecoveryError('inactive'); }
}

export async function ownerConnectorAnswerAvailable() {
  try {
    const {data,error} = await supabaseAdmin.rpc('connector_ask_answer_ready').abortSignal(AbortSignal.timeout(5000));
    return !error && data === true;
  } catch { return false; }
}

export async function publishOwnerConnectorAnswer(scope: AssistantRecoveryScope, claimIds: readonly string[], text: string) {
  const answer = answerText(text);
  try {
    const {data,error} = await supabaseAdmin.rpc('store_connector_ask_answer', {
      p_action_id:scope.userMessageLogId, p_claim_ids:claimIds, p_answer:answer, p_runtime:assistantRuntimeProvenance(),
    }).abortSignal(AbortSignal.timeout(5000));
    if (error || data !== true) throw new RecoveryError('conflict');
  } catch { throw new RecoveryError('conflict'); }
  return answerLink(scope);
}