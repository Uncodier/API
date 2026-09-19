export type PlanWithMetadata = {
  metadata?: Record<string, unknown> | null;
};

export function isWorkflowManagedPlan(plan: PlanWithMetadata | null | undefined): boolean {
  return plan?.metadata?.workflow_run === true || plan?.metadata?.workflow_template === true;
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
  return findAssistantManagedPlan(
    plans?.filter(
      (plan) =>
        !requirementId ||
        plan.metadata?.requirement_id === requirementId,
    ),
  );
}
