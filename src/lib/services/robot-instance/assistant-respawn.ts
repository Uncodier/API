import { supabaseAdmin } from '@/lib/database/supabase-client';
import { claimAssistantRecovery, type AssistantRecoveryScope } from './assistant-recovery';
import type { AssistantSkillSelection } from '@/app/api/robots/instance/assistant/skill-selection';
import { LOOKBACK_MS, MAX_RESPAWNS, SILENT_CONTINUE_PROMPT } from './assistant-respawn-policy';

// Preserve the server-facing API; workflows must import the policy directly.
export {
  evaluateInstanceStall, isIncompleteTurn, LOOKBACK_MS, MAX_RESPAWNS,
  RESPAWN_COOLDOWN_MS, SILENT_CONTINUE_PROMPT, STALL_MS,
  type StallDecision, type StallLogRow,
} from './assistant-respawn-policy';

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
