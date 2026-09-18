import { supabaseAdmin } from '@/lib/database/supabase-client';
import { PLAN_STEP_MAX_RETRIES } from '@/lib/helpers/plan-status';
import { loadRequirement } from '@/lib/services/requirement-backlog-store';

type PlanStep = {
  status?: string;
  retry_count?: number;
  backlog_item_id?: string;
  metadata?: { backlog_item_id?: string };
};

type ActivePlan = {
  steps?: PlanStep[];
  metadata?: { requirement_id?: string; workflow_template?: boolean };
};

export function findRequirementPlan(
  plans: ActivePlan[],
  requirementId: string,
  backlogItemIds: Set<string>,
): ActivePlan | undefined {
  return plans.find(
    (plan) =>
      !plan.metadata?.workflow_template &&
      plan.metadata?.requirement_id === requirementId,
  ) ?? plans.find(
    (plan) =>
      !plan.metadata?.workflow_template &&
      !plan.metadata?.requirement_id &&
      (plan.steps || []).some((step) =>
        backlogItemIds.has(
          step.metadata?.backlog_item_id || step.backlog_item_id || '',
        ),
      ),
  );
}

export function hasOnlyRetryableStepFailures(steps: PlanStep[]): boolean {
  const failed = steps.filter((step) => step.status === 'failed');
  return failed.length > 0 && failed.every(
    (step) => (step.retry_count ?? 0) < PLAN_STEP_MAX_RETRIES,
  );
}

export function hasRunnablePlanWork(steps: PlanStep[]): boolean {
  return steps.some(
    (step) =>
      step.status === 'pending' ||
      step.status === 'in_progress' ||
      (
        step.status === 'failed' &&
        (step.retry_count ?? 0) < PLAN_STEP_MAX_RETRIES
      ),
  );
}

async function loadActiveRequirementPlan(
  instanceId: string,
  requirementId: string,
): Promise<ActivePlan | undefined> {
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('steps, metadata')
    .eq('instance_id', instanceId)
    .in('status', ['pending', 'in_progress', 'active'])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(10);

  if (error) {
    console.warn(
      `[CycleWrapUp] Could not inspect retryable plan failures: ${error.message}`,
    );
    return undefined;
  }

  const plans = (data || []) as ActivePlan[];
  const explicitPlan = findRequirementPlan(plans, requirementId, new Set());
  if (explicitPlan) return explicitPlan;

  // Legacy plans predate plan-level requirement metadata. Scope them through
  // their backlog item links so unrelated generic instance plans remain inert.
  const requirement = await loadRequirement(requirementId).catch(() => null);
  const itemIds = new Set(
    Array.isArray(requirement?.backlog?.items)
      ? requirement.backlog.items
        .map((item: { id?: string }) => item.id)
        .filter((id: unknown): id is string => typeof id === 'string')
      : [],
  );
  return findRequirementPlan(plans, requirementId, itemIds);
}

export async function hasRetryablePlanFailure(
  instanceId: string,
  requirementId: string,
): Promise<boolean> {
  const requirementPlan = await loadActiveRequirementPlan(
    instanceId,
    requirementId,
  );
  return hasOnlyRetryableStepFailures(
    Array.isArray(requirementPlan?.steps) ? requirementPlan.steps : [],
  );
}

export async function hasRunnableRequirementPlan(
  instanceId: string,
  requirementId: string,
): Promise<boolean> {
  const requirementPlan = await loadActiveRequirementPlan(
    instanceId,
    requirementId,
  );
  return hasRunnablePlanWork(
    Array.isArray(requirementPlan?.steps) ? requirementPlan.steps : [],
  );
}
