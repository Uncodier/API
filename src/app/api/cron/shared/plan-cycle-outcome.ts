import type { CronCycleOutcome } from '@/lib/services/requirement-metadata-patch';

export function finalizePlanCycleOutcome(params: {
  completedStepsBefore: number;
  completedStepsAfter: number;
  attemptedProductWork: boolean;
  infrastructureHalt: boolean;
  currentOutcome: CronCycleOutcome;
}): CronCycleOutcome {
  const completedDelta =
    params.completedStepsAfter - params.completedStepsBefore;

  if (completedDelta > 0) return 'progress';
  if (
    params.attemptedProductWork &&
    !params.infrastructureHalt &&
    params.currentOutcome === 'idle'
  ) {
    return 'product_no_progress';
  }
  return params.currentOutcome;
}
