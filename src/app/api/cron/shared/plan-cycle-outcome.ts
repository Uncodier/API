import type { CronCycleOutcome } from '@/lib/services/requirement-metadata-patch';

export function shouldPersistCycleWorkspace(params: {
  infrastructureHalt: boolean;
  persistWorkspaceOnInfrastructureHalt: boolean;
}): boolean {
  return (
    !params.infrastructureHalt ||
    params.persistWorkspaceOnInfrastructureHalt
  );
}

export function finalizePlanCycleOutcome(params: {
  completedStepsBefore: number;
  completedStepsAfter: number;
  attemptedProductWork: boolean;
  durableProductProgress?: boolean;
  infrastructureHalt: boolean;
  currentOutcome: CronCycleOutcome;
}): CronCycleOutcome {
  const completedDelta =
    params.completedStepsAfter - params.completedStepsBefore;

  if (
    params.currentOutcome === 'product_failure' ||
    params.currentOutcome === 'infrastructure_wait' ||
    params.currentOutcome === 'infrastructure_retry' ||
    params.currentOutcome === 'infrastructure_exhausted' ||
    params.currentOutcome === 'paused' ||
    params.currentOutcome === 'remediation_handoff'
  ) {
    return params.currentOutcome;
  }
  if (completedDelta > 0 || params.durableProductProgress === true) {
    return 'progress';
  }
  if (
    params.attemptedProductWork &&
    !params.infrastructureHalt &&
    params.currentOutcome === 'idle'
  ) {
    return 'product_no_progress';
  }
  return params.currentOutcome;
}

export function selectCycleAccountingScope(params: {
  outcome: CronCycleOutcome;
  attemptedPlanId?: string;
  attemptedStepId?: string;
  progressPlanId?: string;
  progressStepId?: string;
}): { planId?: string; stepId?: string } {
  if (
    params.outcome === 'progress' &&
    params.progressPlanId &&
    params.progressStepId
  ) {
    return {
      planId: params.progressPlanId,
      stepId: params.progressStepId,
    };
  }
  return {
    planId: params.attemptedPlanId,
    stepId: params.attemptedStepId,
  };
}
