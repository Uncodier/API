import { supabaseAdmin } from '@/lib/database/supabase-client';

type CancellationParams = {
  requirementId: string;
  itemId: string;
  affectedItemIds?: string[];
  reason: string;
  instanceId?: string;
};

export interface CancelPlanStepsForItemResult {
  plansTouched: number;
  plansCancelled: number;
  stepsCancelled: number;
  planIds: string[];
  errors: string[];
}

export function applyItemExhaustionToSteps(
  steps: any[],
  itemId: string | string[],
  reason: string,
  nowIso: string,
): { nextSteps: any[]; stepsCancelled: number; stillRunnable: boolean } {
  const itemIds = new Set(Array.isArray(itemId) ? itemId : [itemId]);
  const cancelStatuses = new Set(['pending', 'in_progress', 'failed']);
  const terminalStatuses = new Set([
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ]);
  let stepsCancelled = 0;
  const nextSteps = steps.map((step) => {
    const boundId: string | undefined =
      step?.metadata?.backlog_item_id || step?.backlog_item_id;
    if (!boundId || !itemIds.has(boundId)) return step;
    if (!cancelStatuses.has(step?.status)) return step;
    stepsCancelled++;
    return {
      ...step,
      status: 'cancelled',
      cancellation_reason: reason,
      cancelled_at: nowIso,
    };
  });
  const stillRunnable = nextSteps.some(
    (step) =>
      !terminalStatuses.has(step?.status) && step?.status !== 'paused',
  );
  return { nextSteps, stepsCancelled, stillRunnable };
}

export async function cancelPlanStepsForBacklogItem(
  params: CancellationParams,
): Promise<CancelPlanStepsForItemResult> {
  const result: CancelPlanStepsForItemResult = {
    plansTouched: 0,
    plansCancelled: 0,
    stepsCancelled: 0,
    planIds: [],
    errors: [],
  };
  if (!params.itemId) return result;

  const itemIds = Array.from(new Set([
    params.itemId,
    ...(params.affectedItemIds || []),
  ]));
  const { data, error } = await supabaseAdmin.rpc(
    'cancel_requirement_plan_steps_for_backlog_items',
    {
      p_requirement_id: params.requirementId,
      p_item_ids: itemIds,
      p_reason: params.reason,
      p_instance_id: params.instanceId || null,
    },
  );
  if (error) {
    result.errors.push(`cancel_plan_steps: ${error.message}`);
    return result;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    result.errors.push('cancel_plan_steps: RPC returned an invalid result');
    return result;
  }

  const payload = data as Record<string, unknown>;
  return {
    plansTouched: Number(payload.plans_touched) || 0,
    plansCancelled: Number(payload.plans_cancelled) || 0,
    stepsCancelled: Number(payload.steps_cancelled) || 0,
    planIds: Array.isArray(payload.plan_ids)
      ? payload.plan_ids.filter(
        (planId): planId is string => typeof planId === 'string',
      )
      : [],
    errors: Array.isArray(payload.errors)
      ? payload.errors.filter(
        (message): message is string => typeof message === 'string',
      )
      : [],
  };
}
