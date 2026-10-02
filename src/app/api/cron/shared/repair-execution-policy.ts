import type {
  JudgeRepairRun,
  RepairAction,
} from './judge-repair-controller';

// This marker only disables a cached/gate-only shortcut. It never grants tools,
// resets budgets, releases holds, or approves product/SQL execution.
export const IMPLEMENTATION_FEEDBACK_PREFIX = '[implementation_pending] ';
export function hasImplementationFeedback(previousError: unknown): boolean {
  return typeof previousError === 'string' && previousError.startsWith(IMPLEMENTATION_FEEDBACK_PREFIX);
}

export function canResumeCachedGate(
  repairRun: JudgeRepairRun | undefined,
  pendingAction: RepairAction | undefined,
  previousError?: unknown,
): boolean {
  return !hasImplementationFeedback(previousError) && !pendingAction && repairRun?.status !== 'in_progress';
}

export function shouldEnterRepairGateOnlyPhase(
  repairRun: JudgeRepairRun | undefined,
  previousError?: unknown,
): boolean {
  return !hasImplementationFeedback(previousError) && repairRun?.status === 'materialized';
}

export function shouldRunGateAfterTurn(params: {
  repairRun?: JudgeRepairRun;
  assistantDone: boolean;
  completionRequested: boolean;
}): boolean {
  if (params.repairRun?.status === 'in_progress') return false;
  return params.repairRun?.status === 'materialized' ||
    params.assistantDone ||
    params.completionRequested;
}