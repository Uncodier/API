import type {
  JudgeRepairRun,
  RepairAction,
} from './judge-repair-controller';

export function canResumeCachedGate(
  repairRun: JudgeRepairRun | undefined,
  pendingAction: RepairAction | undefined,
): boolean {
  return !pendingAction && repairRun?.status !== 'in_progress';
}

export function shouldEnterRepairGateOnlyPhase(
  repairRun: JudgeRepairRun | undefined,
): boolean {
  return repairRun?.status === 'materialized';
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