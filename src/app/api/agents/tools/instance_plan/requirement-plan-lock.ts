import { supabaseAdmin } from '@/lib/database/supabase-client';
import { PLAN_STEP_MAX_RETRIES } from '@/lib/helpers/plan-status';

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
        !plan.metadata?.workflow_template &&
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
  /** Step-level terminal updates remain available for plan adaptation. */
  steps?: Array<{ status?: string }>;
}): void {
  if (!input.requirementId) return;

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  const changesPlanTerminalState =
    input.status !== undefined && terminalStatuses.has(input.status);
  if (!changesPlanTerminalState) return;

  throw new Error(
    `Requirement ${input.requirementId} plan terminal transitions are ` +
      'runner-owned. Do not complete, fail, or cancel a plan with ' +
      'action="update"; finish the current step with action="execute_step".',
  );
}
