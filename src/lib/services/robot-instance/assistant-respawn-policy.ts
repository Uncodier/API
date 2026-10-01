// Workflow-safe policy only. Keep database, Node.js and workflow/api imports in
// assistant-respawn.ts, called through the assistant respawn steps.
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
 * logs must be newest-first.
 * Includes infrastructure rows used for cooldown.
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