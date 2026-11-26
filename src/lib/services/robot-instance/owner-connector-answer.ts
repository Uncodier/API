import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { confirmDirectResultRelease } from '@/lib/connectors/provider-direct-receipt';
import { redactUserText } from '@/lib/harness/security';
import { assistantRuntimeProvenance } from './assistant-context-version';
import { RecoveryError, type AssistantRecoveryScope } from './assistant-recovery-schema';
import { z } from 'zod';

const followupSchema = z.union([
  z.object({ source_id: z.string().uuid(), answer: z.string().min(1).max(65_536),
    connector_ids:z.array(z.string().uuid()).max(100),
    record_ids:z.array(z.string().uuid()).min(1).max(8).optional(),
    tool_context:z.array(z.object({claim_id:z.string().uuid(),result:z.unknown()}).strict()
      .refine(entry => Object.hasOwn(entry,'result'))).max(8).refine(entries => Buffer.byteLength(JSON.stringify(entries)) <= 131072),
  }).strict().refine(turn => turn.connector_ids.length > 0 || Boolean(turn.record_ids?.length)),
  z.object({ unavailable: z.literal(true) }).strict(),
]);

export async function loadOwnerConnectorFollowup(scope: AssistantRecoveryScope) {
  // Retry only this authorized lookup, never the surrounding model/tool turn.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const {data,error,status} = await supabaseAdmin.rpc('connector_ask_context', {
        p_action_id: scope.userMessageLogId,
      }).abortSignal(AbortSignal.timeout(5000));
      if (!error) return data === null ? undefined : followupSchema.parse(data);
      if (attempt || !([0, 502, 503, 504].includes(status) || ['40001','40P01','55P03'].includes(error.code))) break;
    } catch (error) {
      if (attempt || !(error instanceof Error && ['TimeoutError','AbortError'].includes(error.name))) break;
    }
  }
  // Missing migration, revoked access, invalid payload or persistent outage.
  // A continuation without the original private context is not a safe fallback.
  throw new RecoveryError('private_context_unavailable');
}

function answerText(text: string) {
  const answer = redactUserText(text).trim();
  if (!answer || Buffer.byteLength(answer) > 65_536 || answer.includes('\0')) throw new RecoveryError('invalid_state');
  return answer;
}

function answerLink(scope: AssistantRecoveryScope, linked: boolean) {
  return `This answer uses private ${linked ? 'workspace' : 'connector'} data. [Open your answer](/robots/private-answer/${scope.userMessageLogId}).`;
}

export function privateContextUnavailable(): never { throw new RecoveryError('private_context_unavailable'); }

const linkedRows = z.array(z.object({
  id:z.string().uuid(), title:z.string().nullable(), description:z.string().nullable(),
  data:z.unknown(), updated_at:z.string().nullable(),
}).strict().refine(row => Object.hasOwn(row, 'data'))).min(1).max(8);

export async function loadOwnerAskRecords(scope: AssistantRecoveryScope, ids: readonly string[]) {
  try {
    const {data,error} = await supabaseAdmin.rpc('read_ask_linked_records', {
      p_action_id:scope.userMessageLogId, p_record_ids:ids,
    }).abortSignal(AbortSignal.timeout(5000));
    if (!error && Buffer.byteLength(JSON.stringify(data)) <= 131072) {
      const rows = linkedRows.parse(data);
      const byId = new Map(rows.map(row => [row.id,row]));
      if (rows.length === ids.length && ids.every(id => byId.has(id))) return ids.map(id => byId.get(id)!);
    }
  } catch { /* Never surface DB error details or partial source material. */ }
  return privateContextUnavailable();
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

export async function publishOwnerConnectorAnswer(scope: AssistantRecoveryScope, claimIds: readonly string[], text: string,
  toolContext: readonly {claim_id:string;result:unknown}[], sourceId?: string, recordIds: readonly string[] = []) {
  const linked = recordIds.length > 0;
  const answer = answerText(linked ? `${text}\n\nRecord sources:\n${recordIds.map(id => `- [Record ${id}](/records/${id})`).join('\n')}` : text);
  try {
    const {data,error} = await supabaseAdmin.rpc(linked ? 'store_linked_record_ask_turn' : 'store_connector_ask_turn', {
      p_action_id:scope.userMessageLogId, p_claim_ids:claimIds, p_answer:answer, p_tool_context:toolContext, p_source_id:sourceId ?? null,
      p_runtime:assistantRuntimeProvenance(), ...(linked && {p_record_ids:recordIds}),
    }).abortSignal(AbortSignal.timeout(5000));
    if (error || data !== true) throw new RecoveryError('conflict');
  } catch { throw new RecoveryError('conflict'); }
  return answerLink(scope, linked);
}
