export type PlanWithMetadata = {
  metadata?: Record<string, unknown> | null;
};

export function isWorkflowManagedPlan(plan: PlanWithMetadata | null | undefined): boolean {
  return plan?.metadata?.workflow_run === true || plan?.metadata?.workflow_template === true;
}

export function isRespawnManagedPlan(plan: PlanWithMetadata | null | undefined): boolean {
  return (
    isWorkflowManagedPlan(plan) ||
    typeof plan?.metadata?.requirement_id === 'string'
  );
}

export function findAssistantManagedPlan<T extends PlanWithMetadata>(
  plans: T[] | null | undefined,
): T | undefined {
  return plans?.find((plan) => !isWorkflowManagedPlan(plan));
}

export function findAssistantManagedPlanForRequirement<
  T extends PlanWithMetadata,
>(
  plans: T[] | null | undefined,
  requirementId?: string,
): T | undefined {
  const assistantPlans = plans?.filter((plan) => !isWorkflowManagedPlan(plan));
  if (!requirementId) return assistantPlans?.[0];
  return assistantPlans?.find(
    (plan) => plan.metadata?.requirement_id === requirementId,
  ) ?? assistantPlans?.find(
    (plan) => !plan.metadata?.requirement_id,
  );
}
