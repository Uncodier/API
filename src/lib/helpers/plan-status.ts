export const PLAN_STEP_MAX_RETRIES = 2;

export type ReconciledPlanStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface PlanStepSummary {
  status: ReconciledPlanStatus;
  completedCount: number;
  totalCount: number;
  progressPercentage: number;
  anyFailed: boolean;
  anyCancelled: boolean;
  hasRunnable: boolean;
}

export function summarizePlanSteps(
  steps: Array<{ status?: string; retry_count?: number }>,
  maxRetries: number = PLAN_STEP_MAX_RETRIES,
): PlanStepSummary {
  const completedCount = steps.filter((step) => step.status === 'completed').length;
  const totalCount = steps.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;
  const anyFailed = steps.some((step) => step.status === 'failed');
  const anyCancelled = steps.some(
    (step) => step.status === 'cancelled' || step.status === 'skipped',
  );
  const hasRunnable = steps.some((step) =>
    step.status === 'pending' ||
    step.status === 'in_progress' ||
    (step.status === 'failed' && (step.retry_count ?? 0) < maxRetries),
  );

  let status: ReconciledPlanStatus = 'in_progress';
  if (allCompleted) status = 'completed';
  else if (!hasRunnable && anyFailed) status = 'failed';
  else if (!hasRunnable && anyCancelled) status = 'cancelled';

  return {
    status,
    completedCount,
    totalCount,
    progressPercentage: totalCount > 0
      ? Math.round((completedCount / totalCount) * 100)
      : 0,
    anyFailed,
    anyCancelled,
    hasRunnable,
  };
}

export function isStrictFinalPlanStep(
  steps: Array<{ id?: string; status?: string }>,
  currentStepId: string,
): boolean {
  if (
    !currentStepId ||
    steps.filter((step) => step.id === currentStepId).length !== 1
  ) {
    return false;
  }
  return steps.every(
    (step) =>
      step.id === currentStepId ||
      ['completed', 'cancelled', 'skipped'].includes(step.status || ''),
  );
}

export function closeSupersededPlan(
  steps: Array<Record<string, any>>,
  reason: string,
  nowIso: string,
): {
  status: 'completed' | 'cancelled';
  steps: Array<Record<string, any>>;
  completedCount: number;
  progressPercentage: number;
} {
  const allCompleted = steps.length > 0 && steps.every((step) => step.status === 'completed');
  if (allCompleted) {
    return {
      status: 'completed',
      steps,
      completedCount: steps.length,
      progressPercentage: 100,
    };
  }

  const nextSteps = steps.map((step) => {
    if (['completed', 'failed', 'cancelled', 'skipped'].includes(step.status)) return step;
    return {
      ...step,
      status: 'cancelled',
      cancellation_reason: reason,
      cancelled_at: nowIso,
      completed_at: step.completed_at || nowIso,
    };
  });
  const completedCount = nextSteps.filter((step) => step.status === 'completed').length;

  return {
    status: 'cancelled',
    steps: nextSteps,
    completedCount,
    progressPercentage: nextSteps.length > 0
      ? Math.round((completedCount / nextSteps.length) * 100)
      : 0,
  };
}
