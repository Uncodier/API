import { supabaseAdmin } from '@/lib/database/supabase-client';
import { PLAN_STEP_MAX_RETRIES } from '@/lib/helpers/plan-status';
import { isWorkflowManagedPlan } from '@/lib/services/workflow-robot/plan-ownership';

export const ACTIVE_PLAN_STATUSES = [
  'pending',
  'in_progress',
  'active',
  'paused',
] as const;

export type ActivePlanSummary = {
  id: string;
  title?: string | null;
  status: string;
  createdAt?: string | null;
};

export function shouldProtectRequirementPlanCreation(input: {
  requirementId?: string;
  isTemplate?: boolean;
}): boolean {
  return Boolean(input.requirementId && !input.isTemplate);
}

export async function getBlockingActivePlans(input: {
  instanceId: string;
  requirementId?: string;
}): Promise<ActivePlanSummary[]> {
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('id, title, status, metadata, steps, created_at')
    .eq('instance_id', input.instanceId)
    .in('status', [...ACTIVE_PLAN_STATUSES]);

  if (error) {
    throw new Error(`Failed to verify active instance plans: ${error.message}`);
  }

  return (data || [])
    .filter(
      (plan) =>
        !isWorkflowManagedPlan(plan) &&
        (
          !input.requirementId ||
          plan.metadata?.requirement_id === input.requirementId
        ) &&
        hasRunnablePlanSteps(Array.isArray(plan.steps) ? plan.steps : []),
    )
    .map((plan) => ({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      createdAt: plan.created_at,
    }))
    .sort(comparePlanAge);
}

export function hasRunnablePlanSteps(
  steps: Array<{ status?: string; retry_count?: number }>,
): boolean {
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

function comparePlanAge(a: ActivePlanSummary, b: ActivePlanSummary): number {
  const byCreatedAt = String(a.createdAt || '').localeCompare(
    String(b.createdAt || ''),
  );
  return byCreatedAt || a.id.localeCompare(b.id);
}

export function activeRequirementPlanError(
  requirementId: string,
  plan: ActivePlanSummary,
): Error {
  const label = plan.title ? ` "${plan.title}"` : '';
  return new Error(
    `Requirement ${requirementId} already has active plan ${plan.id}${label} ` +
      `(status=${plan.status}). Continue or update that plan; do not create a ` +
      'replacement. Executors finish the current step with instance_plan ' +
      'action="execute_step". Only runner-owned recovery may supersede an ' +
      'active requirement plan.',
  );
}

export function assertRequirementPlanUpdateAllowed(input: {
  requirementId?: string;
  status?: string;
  /** Cancellation remains available only when executable replacement work remains. */
  steps?: Array<{ id?: string; order?: number; status?: string }>;
  existingSteps?: Array<{
    id?: string;
    order?: number;
    status?: string;
    retry_count?: number;
  }>;
}): void {
  if (!input.requirementId) return;

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  const changesPlanTerminalState =
    input.status !== undefined && terminalStatuses.has(input.status);
  const changesStepExecutionResult = (input.steps || []).some(
    (step) => step.status === 'completed' || step.status === 'failed',
  );
  const changesStepCancellation = (input.steps || []).some(
    (step) => step.status === 'cancelled',
  );
  if (changesStepCancellation) {
    const matches = (
      current: { id?: string; order?: number },
      incoming: { id?: string; order?: number },
    ) =>
      Boolean(
        (incoming.id && incoming.id === current.id) ||
        (
          incoming.order !== undefined &&
          incoming.order === current.order
        ),
      );
    const incomingSteps = input.steps || [];
    const existingSteps = input.existingSteps || [];
    const projectedSteps = existingSteps.map((current) => ({
      ...current,
      ...(incomingSteps.find((incoming) => matches(current, incoming)) || {}),
    }));
    for (const incoming of incomingSteps) {
      if (!existingSteps.some((current) => matches(current, incoming))) {
        projectedSteps.push({
          ...incoming,
          status: incoming.status || 'pending',
        });
      }
    }
    if (!hasRunnablePlanSteps(projectedSteps)) {
      throw new Error(
        `Requirement ${input.requirementId} plan adaptation cannot cancel ` +
          'all executable steps. Add a pending replacement in the same update.',
      );
    }
  }
  if (
    !changesPlanTerminalState &&
    !changesStepExecutionResult
  ) return;

  throw new Error(
    `Requirement ${input.requirementId} plan and step execution results are ` +
      'runner-owned. Do not complete or fail steps, or complete, fail, or ' +
      'cancel a plan with action="update"; the executor must request a ' +
      'terminal step result and let the runner execute its gate.',
  );
}

export function isRunnerOwnedRequirementStepTerminal(input: {
  requirementId?: string;
  stepStatus?: string;
}): boolean {
  return Boolean(
    input.requirementId &&
    (input.stepStatus === 'completed' || input.stepStatus === 'failed'),
  );
}
