import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { captureRecoveryNodeFingerprint } from './assistant-recovery-fingerprint';
import {
  assertRecoveryScope, canonicalRecoveryJson, cloneRecoveryJson, isRecord,
  MAX_RECOVERY_RESPAWNS, parseRecoveryCheckpoint, parseRecoveryExecution,
  parseRecoverySnapshot, RecoveryError,
  type AssistantRecoveryExecution, type AssistantRecoveryScope, type AssistantRecoverySnapshot,
} from './assistant-recovery-schema';

export { RecoveryError } from './assistant-recovery-schema';
export type {
  AssistantRecoveryExecution, AssistantRecoveryScope, AssistantRecoverySnapshot, RecoveryErrorCode,
} from './assistant-recovery-schema';

const ACTION_COLUMNS = 'id,instance_id,site_id,user_id,log_type,trusted_user_action,details';
type Action = { details: Record<string, unknown> };
type ActiveRecovery = Action & { snapshot: AssistantRecoverySnapshot };

/** Internal server boundary only. The caller must already authorize this trusted scope. */
function scopedAction(scope: AssistantRecoveryScope) {
  return supabaseAdmin.from('instance_logs').select(ACTION_COLUMNS)
    .eq('id', scope.userMessageLogId).eq('instance_id', scope.instanceId)
    .eq('site_id', scope.siteId).eq('user_id', scope.userId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true);
}

async function assertLatest(scope: AssistantRecoveryScope): Promise<void> {
  // Deliberately not user-filtered: a new action from another tenant member supersedes this one.
  const { data, error } = await supabaseAdmin.from('instance_logs').select('id')
    .eq('instance_id', scope.instanceId).eq('site_id', scope.siteId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new RecoveryError('conflict');
  if (!data?.length || data[0].id !== scope.userMessageLogId) throw new RecoveryError('inactive');
}

async function readAction(scope: AssistantRecoveryScope, initializing = false): Promise<Action> {
  assertRecoveryScope(scope);
  const { data, error } = await scopedAction(scope).maybeSingle();
  if (error) throw new RecoveryError('conflict');
  if (!data || data.id !== scope.userMessageLogId || data.instance_id !== scope.instanceId ||
      data.site_id !== scope.siteId || data.user_id !== scope.userId ||
      data.log_type !== 'user_action' || data.trusted_user_action !== true) throw new RecoveryError('missing');
  if (data.details !== null && !isRecord(data.details)) throw new RecoveryError('invalid_state');
  const originalDetails = cloneRecoveryJson(data.details, 4 * 1024 * 1024, false);
  const details: Record<string, unknown> = originalDetails ?? {};
  if (details.status !== 'running' && !(initializing && !Object.hasOwn(details, 'status'))) {
    throw new RecoveryError('inactive');
  }
  await assertLatest(scope);
  return { details };
}

async function readRecovery(scope: AssistantRecoveryScope): Promise<ActiveRecovery> {
  const action = await readAction(scope);
  if (!Object.hasOwn(action.details, 'assistant_recovery')) throw new RecoveryError('missing');
  const snapshot = parseRecoverySnapshot(action.details.assistant_recovery);
  if (snapshot.execution.instanceNodeId) {
    const fingerprint = await captureRecoveryNodeFingerprint(scope, snapshot.execution.instanceNodeId);
    if (fingerprint !== snapshot.nodeFingerprint) throw new RecoveryError('context_changed');
    // A cancellation/new action during the multi-query fingerprint read must not be overlooked.
    const current = await readAction(scope);
    if (canonicalRecoveryJson(current.details) !== canonicalRecoveryJson(action.details)) {
      throw new RecoveryError('conflict');
    }
  }
  return { ...action, snapshot };
}

function assertOwner(scope: AssistantRecoveryScope, snapshot: AssistantRecoverySnapshot): void {
  if (snapshot.lease_token || snapshot.respawnCount !== (scope.generation ?? 0)) {
    throw new RecoveryError('conflict');
  }
}

async function compareAndSwap(scope: AssistantRecoveryScope, action: Action, snapshot: AssistantRecoverySnapshot): Promise<AssistantRecoverySnapshot> {
  const next = { ...snapshot, revision: randomUUID() };
  const details = { ...action.details, status: 'running', assistant_recovery: next };
  await assertLatest(scope);
  let query = supabaseAdmin.from('instance_logs').update({ details })
    .eq('id', scope.userMessageLogId).eq('instance_id', scope.instanceId)
    .eq('site_id', scope.siteId).eq('user_id', scope.userId)
    .eq('log_type', 'user_action').eq('trusted_user_action', true);
  // Bounded JSON-path filters work even with 512 KiB receipts. Recovery writers
  // own the revision; all status writers must CAS the observed status/revision.
  // Unrelated details are preserved from this read, not merged transactionally.
  if (Object.hasOwn(action.details, 'assistant_recovery')) {
    const previous = parseRecoverySnapshot(action.details.assistant_recovery);
    query = query.eq('details->assistant_recovery->>revision', previous.revision)
      .eq('details->>status', 'running');
  } else {
    query = query.is('details->assistant_recovery', null);
    query = action.details.status === 'running'
      ? query.eq('details->>status', 'running') : query.is('details->>status', null);
  }
  const { data, error } = await query.select('id');
  if (error || !data || data.length !== 1 || data[0].id !== scope.userMessageLogId) {
    throw new RecoveryError('conflict');
  }
  // No cross-row transaction is available without DDL. Recheck after the CAS;
  // callers also guard immediately before the model and each external tool effect.
  const current = await readRecovery(scope);
  if (canonicalRecoveryJson(current.details) !== canonicalRecoveryJson(details)) throw new RecoveryError('conflict');
  return next;
}

async function safeRecovery<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('conflict');
  }
}

export async function initializeAssistantRecovery(scope: AssistantRecoveryScope, execution: AssistantRecoveryExecution): Promise<void> {
  return safeRecovery(async () => {
    const action = await readAction(scope, true);
    const frozenExecution = parseRecoveryExecution(execution);
    const nodeFingerprint = frozenExecution.instanceNodeId
      ? await captureRecoveryNodeFingerprint(scope, frozenExecution.instanceNodeId) : undefined;
    const snapshot: AssistantRecoverySnapshot = {
      version: 1, revision: randomUUID(), execution: frozenExecution, messages: [], inFlight: false, respawnCount: 0,
      ...(nodeFingerprint ? { nodeFingerprint } : {}),
    };
    if (Object.hasOwn(action.details, 'assistant_recovery')) {
      // Durable retries may initialize the same pristine state, never reset progress.
      const existing = await readRecovery(scope);
      assertOwner(scope, existing.snapshot);
      if (canonicalRecoveryJson({ ...existing.snapshot, revision: snapshot.revision }) !== canonicalRecoveryJson(snapshot)) {
        throw new RecoveryError('conflict');
      }
      return;
    }
    if ((scope.generation ?? 0) !== 0) throw new RecoveryError('conflict');
    await compareAndSwap(scope, action, snapshot);
  });
}

export async function assertAssistantRecoveryActive(scope: AssistantRecoveryScope): Promise<void> {
  return safeRecovery(async () => {
    const { snapshot } = await readRecovery(scope);
    assertOwner(scope, snapshot);
  });
}

export async function markAssistantRecoveryInFlight(scope: AssistantRecoveryScope): Promise<void> {
  return safeRecovery(async () => {
    const active = await readRecovery(scope);
    assertOwner(scope, active.snapshot);
    if (active.snapshot.inFlight) throw new RecoveryError('in_flight');
    await compareAndSwap(scope, active, { ...active.snapshot, inFlight: true });
  });
}

export async function checkpointAssistantRecovery(
  scope: AssistantRecoveryScope,
  checkpoint: { messages: unknown[]; continuation?: { responseNodeIds: string[] } },
): Promise<void> {
  return safeRecovery(async () => {
    const active = await readRecovery(scope);
    assertOwner(scope, active.snapshot);
    const frozen = parseRecoveryCheckpoint({
      messages: checkpoint.messages,
      ...(checkpoint.continuation !== undefined ? { continuation: checkpoint.continuation } : {}),
    });
    await compareAndSwap(scope, active, { ...active.snapshot, ...frozen, inFlight: false });
  });
}

export async function claimAssistantRecovery(scope: AssistantRecoveryScope): Promise<{
  snapshot: AssistantRecoverySnapshot;
  resumeToken: string;
}> {
  return safeRecovery(async () => {
    const active = await readRecovery(scope);
    if (active.snapshot.inFlight) throw new RecoveryError('in_flight');
    if (active.snapshot.lease_token) throw new RecoveryError('conflict');
    if (!active.snapshot.messages.length) throw new RecoveryError('missing');
    if (active.snapshot.respawnCount >= MAX_RECOVERY_RESPAWNS) throw new RecoveryError('limit');
    if (active.snapshot.execution.instanceNodeId &&
        ((active.snapshot.execution.expectedResultsAmount ?? 1) > 1 ||
         active.snapshot.continuation?.responseNodeIds.length !== 1)) throw new RecoveryError('invalid_state');
    const resumeToken = randomUUID();
    const snapshot = await compareAndSwap(scope, active, {
      ...active.snapshot, respawnCount: active.snapshot.respawnCount + 1, lease_token: resumeToken,
    });
    return { snapshot, resumeToken };
  });
}

export async function loadAssistantRecovery(scope: AssistantRecoveryScope, resumeToken: string): Promise<AssistantRecoverySnapshot> {
  return safeRecovery(async () => {
    const active = await readRecovery(scope);
    if (!resumeToken || active.snapshot.lease_token !== resumeToken) throw new RecoveryError('conflict');
    if (active.snapshot.inFlight) throw new RecoveryError('in_flight');
    const { lease_token: _consumed, ...snapshot } = active.snapshot;
    return compareAndSwap(scope, active, snapshot);
  });
}