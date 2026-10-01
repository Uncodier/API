import { supabaseAdmin } from '@/lib/database/supabase-client';
import { claimAssistantRecovery, type AssistantRecoveryScope } from './assistant-recovery';
import type { AssistantSkillSelection } from '@/app/api/robots/instance/assistant/skill-selection';

export const MAX_RESPAWNS = 2;
export const STALL_MS = 3 * 60 * 1000;
export const LOOKBACK_MS = 30 * 60 * 1000;
export const RESPAWN_COOLDOWN_MS = 2 * 60 * 1000;

export const SILENT_CONTINUE_PROMPT =
  'The previous execution was interrupted or exhausted its turn limit without providing a final response. Please read the context from the history and continue the task seamlessly. Do not ask for confirmation, just provide the final answer or next tool calls as if no interruption occurred.';

export type StallDecision =
  | 'respawn'
  | 'healthy_or_fresh'
  | 'has_user_action'
  | 'in_cooldown'
  | 'max_respawns_reached'
  | 'no_logs';

export type StallLogRow = {
  log_type: string;
  message?: string | null;
  created_at: string;
  details?: { source?: string } | null;
};

export function isIncompleteTurn(result: { isDone?: boolean; text?: string | null }) {
  return !result.isDone || !result.text?.trim();
}

/**
 * logs must be newest-first. Includes infrastructure rows used for cooldown.
 */
export function evaluateInstanceStall(params: {
  logs: StallLogRow[];
  nowMs: number;
  recentRespawnCount: number;
}): StallDecision {
  const { logs, nowMs, recentRespawnCount } = params;
  const interactionLogs = logs.filter((row) => row.log_type !== 'infrastructure');
  if (interactionLogs.length === 0) return 'no_logs';

  const lastLog = interactionLogs[0];
  if (lastLog.log_type === 'user_action') return 'has_user_action';

  const lastLogTime = new Date(lastLog.created_at).getTime();
  const isStallState =
    lastLog.log_type === 'thinking' ||
    lastLog.log_type === 'tool_call' ||
    (lastLog.log_type === 'agent_action' && !lastLog.message?.trim());

  if (!isStallState || nowMs - lastLogTime < STALL_MS) {
    return 'healthy_or_fresh';
  }

  const respawnLogs = logs.filter(
    (row) => row.log_type === 'infrastructure' && row.details?.source === 'assistant_respawn',
  );
  if (respawnLogs.length > 0) {
    const lastRespawnTime = new Date(respawnLogs[0].created_at).getTime();
    if (nowMs - lastRespawnTime < RESPAWN_COOLDOWN_MS) return 'in_cooldown';
  }

  if (recentRespawnCount >= MAX_RESPAWNS) return 'max_respawns_reached';
  return 'respawn';
}

export async function countRecentRespawns(instanceId: string): Promise<number> {
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();

  const { count, error } = await supabaseAdmin
    .from('instance_logs')
    .select('*', { count: 'exact', head: true })
    .eq('instance_id', instanceId)
    .eq('log_type', 'infrastructure')
    .gte('created_at', since)
    .contains('details', { source: 'assistant_respawn' });

  if (error) {
    console.error(`[AssistantRespawn] Error counting recent respawns for instance ${instanceId}:`, error);
    return MAX_RESPAWNS;
  }

  return count || 0;
}

export async function insertRespawnLog(instanceId: string, siteId: string, userId?: string | null,
  recovery?: { userMessageLogId: string; instanceNodeId?: string; generation: number }): Promise<void> {
  const { error } = await supabaseAdmin.from('instance_logs').insert({
    log_type: 'infrastructure',
    level: 'info',
    message: 'Assistant execution respawned to continue incomplete turn.',
    details: {
      source: 'assistant_respawn',
      user_message_log_id: recovery?.userMessageLogId,
      instance_node_id: recovery?.instanceNodeId,
      generation: recovery?.generation,
    },
    instance_id: instanceId,
    site_id: siteId,
    user_id: userId || null,
  });

  if (error) {
    console.error(`[AssistantRespawn] Error inserting respawn log for instance ${instanceId}:`, error);
  }
}

export async function spawnSilentContinueWorkflow(scope: AssistantRecoveryScope): Promise<boolean> {
  // Only a complete checkpoint tied to a trusted, still-active user action may
  // restart. Never infer node identity from whichever log happens to be latest.
  let claimed;
  try { claimed = await claimAssistantRecovery(scope); }
  catch { return false; }
  const { snapshot, resumeToken } = claimed;
  const execution = snapshot.execution;

  const { start } = await import('workflow/api');
  const { runAssistantWorkflow } = await import('@/app/api/robots/instance/assistant/workflow');

  const workflowArgs: Parameters<typeof runAssistantWorkflow> = [
    scope.instanceId,
    SILENT_CONTINUE_PROMPT,
    scope.siteId,
    scope.userId,
    execution.customTools,
    execution.useSdkTools,
    execution.systemPrompt,
    execution.agentType,
    execution.userPhone,
    execution.instanceNodeId,
    execution.expectedResultsAmount,
    execution.contextString,
    execution.toolOverrides,
    { silentContinue: true, selectedSkills: execution.selectedSkills as AssistantSkillSelection | undefined,
      approvedImport: execution.approvedImport as { url: string; sha256: string; userId: string } | undefined,
      userMessageLogId: scope.userMessageLogId, resumeToken },
  ];
  try {
    await start(runAssistantWorkflow, workflowArgs);
    await insertRespawnLog(scope.instanceId, scope.siteId, scope.userId, {
      userMessageLogId: scope.userMessageLogId, instanceNodeId: execution.instanceNodeId,
      generation: snapshot.respawnCount,
    });
    return true;
  } catch {
    // Keep the durable claim: ambiguous workflow admission is not safe to replay.
    return false;
  }
}
