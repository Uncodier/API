import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { ToolRequestPrincipal } from '@/lib/security/tool-request-principal';
import { canonicalRecoveryJson } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { insertUserActionLog } from './user-message-log';

const NAMESPACE = '5842b917-2e73-4db2-9027-b5df7587d13c';

// Separate the initial session and action namespaces. The action identity is
// the same if a first-send retry has since learned its assigned instance ID.
function scopeKey(kind: string, siteId: string, userId: string, internal: boolean, instanceId: string | null, requestId: string) {
  return uuidv5(JSON.stringify([kind, siteId.toLowerCase(), userId.toLowerCase(), internal, instanceId?.toLowerCase() ?? null, requestId]), NAMESPACE);
}

export function firstAskInstanceId(siteId: string, userId: string, internal: boolean, requestId: string) {
  return scopeKey('instance', siteId, userId, internal, null, requestId);
}

type SubmissionInput = {
  instanceId: string; siteId: string; userId: string; principal: ToolRequestPrincipal;
  observeFirstSend?: boolean;
  connectionPolicy: boolean;
  body: { message: string; request_id?: string; [field: string]: unknown }; details: Record<string, unknown>;
};

export class AskSubmissionError extends Error {
  constructor(readonly code: 'ASSISTANT_REQUEST_CONFLICT' | 'ASSISTANT_ADMISSION_UNCONFIRMED') {
    super(code === 'ASSISTANT_REQUEST_CONFLICT' ? 'This request ID was already used for different content.' :
      'Assistant admission could not be confirmed. Check the conversation before sending again.');
  }
}

export async function claimAskSubmission(input: SubmissionInput) {
  const { body, instanceId, siteId, userId, principal, connectionPolicy } = input;
  // The route passes only the validated/defaulted schema. Omit addressing:
  // bearer user_id is ignored; site, actor and actual instance scope the PK.
  const { request_id: requestId, site_id: _site, user_id: _actor, instance_id: _instance, ...content } = body;
  if (!requestId) {
    // Legacy non-direct callers have no cross-HTTP idempotency contract. Do
    // not stamp a permanent reservation, retry the write, or dedupe by text.
    const action = await insertUserActionLog({ instanceId, siteId, userId, message: body.message,
      details: input.details, skipDuplicateCheck: true });
    return { id: action.id, replay: false };
  }
  const actionId = scopeKey('action', siteId, userId, principal.internal, instanceId, requestId);
  const digest = createHash('sha256').update(canonicalRecoveryJson([content, principal.userSession === true])).digest('hex');
  if (!input.observeFirstSend) {
    try {
      await insertUserActionLog({ instanceId, siteId, userId, message: body.message, actionId,
        details: { ...input.details, request_id: requestId, ask_request_sha256: digest,
          // Snapshot the server-selected contract at insertion, never from the request body.
          ask_connection_policy: connectionPolicy } });
      return { id: actionId, replay: false };
    } catch (error) {
      if ((error as { code?: string })?.code !== '23505') {
        if (error instanceof Error && ['requirement_execution_busy', 'instance_archived', 'original_instance_archived'].includes(error.message)) throw error;
        throw new AskSubmissionError('ASSISTANT_ADMISSION_UNCONFIRMED');
      }
    }
  }
  // INSERT (not upsert) is the only ownership transition. Read on a fresh
  // statement after PostgreSQL resolves the winner, never from a stale snapshot.
  // The private tombstone can outlive the action: no row is NOT a new claim.
  const signal = AbortSignal.timeout(3_000);
  const read = () => supabaseAdmin.from('instance_logs')
    .select('id,request_id:details->>request_id,digest:details->>ask_request_sha256,status:details->>status')
    .eq('id', actionId).eq('site_id', siteId).eq('user_id', userId).eq('instance_id', instanceId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true).eq('details->>prompt_source', 'assistant_route').abortSignal(signal).maybeSingle();
  let q = await read();
  // Session creation precedes the action's FK insert. A first-send loser may
  // briefly observe that gap. Never adopt an orphaned/pre-existing instance
  // and dispatch from it; only the request that created that session can start.
  if (input.observeFirstSend) {
    for (const delay of [50, 150, 300]) {
      if (q.data || q.error || signal.aborted) break;
      await new Promise(resolve => setTimeout(resolve, delay));
      q = await read();
    }
  }
  if (q.error || q.data?.id !== actionId || q.data.request_id !== requestId || !q.data.digest) {
    throw new AskSubmissionError('ASSISTANT_ADMISSION_UNCONFIRMED');
  }
  if (q.data.digest !== digest) throw new AskSubmissionError('ASSISTANT_REQUEST_CONFLICT');
  const status = ['running', 'completed', 'failed', 'paused', 'stopped', 'cancelled'].includes(q.data.status) ? q.data.status : 'unknown';
  return { id: actionId, replay: true, status };
}
