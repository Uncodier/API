import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isCustomerDecisionBlocker } from './requirement-backlog-blockers';
import type { BacklogBlocker, BacklogItem } from './requirement-backlog-types';
import { sanitizeHarnessData } from './harness-diagnostics/context';
import { countPendingPlanSteps, hasRunnableBacklogWork, technicalReviewBacklogItems } from './cycle-wrapup-prompt';
import { classifyRequirementType, getFlow, productAttemptLimits } from './requirement-flows';

/** Never turn a legacy boolean, prose question, or dependency placeholder into customer authority. */
export async function loadCycleInterventionState(requirementId: string, siteId: string, instanceId?: string): Promise<{
  userDecisionBlockers: BacklogBlocker[]; technicalReviewRequired: boolean; hasRunnableBacklogWork: boolean; hasRunnablePlanWork: boolean;
} | null> {
  const { data, error } = await Promise.resolve(supabaseAdmin.from('requirements').select('backlog,type')
    .eq('id', requirementId).eq('site_id', siteId).maybeSingle()).catch(() => ({ data: null, error: true }));
  // Unknown is not an empty decision list: reporting must not reclassify a real prerequisite.
  if (error || !data) return null;
  if (data.backlog != null && !Array.isArray(data.backlog.items)) return null;
  const items = (data.backlog?.items || []) as BacklogItem[];
  if (items.some(item => !item || typeof item.id !== 'string' ||
      (item.blocked_by != null && !Array.isArray(item.blocked_by)) ||
      (item.depends_on != null && !Array.isArray(item.depends_on)))) return null;
  const limits = productAttemptLimits(getFlow(classifyRequirementType(data.type)));
  let hasRunnablePlanWork = false;
  if (instanceId) {
    // Explicit requirement work may belong to another runner. Only legacy plans
    // need the current instance boundary before their item links establish scope.
    const results = await Promise.all([
      supabaseAdmin.from('instance_plans').select('steps,metadata')
        .eq('site_id', siteId).eq('metadata->>requirement_id', requirementId)
        .in('status', ['pending', 'in_progress', 'active']).limit(101),
      supabaseAdmin.from('instance_plans').select('steps,metadata')
        .eq('site_id', siteId).eq('instance_id', instanceId).is('metadata->>requirement_id', null)
        .in('status', ['pending', 'in_progress', 'active']).limit(101),
    ]).catch(() => null);
    if (!results || results.some(result => result.error || !Array.isArray(result.data) || result.data.length > 100)) return null;
    const itemIds = new Set(items.map(item => item.id));
    const doneItems = items.filter(item => item.status === 'done');
    for (const plan of results.flatMap(result => result.data!)) {
      if (!plan || !Array.isArray(plan.steps)) return null;
      if (plan.metadata?.workflow_template || (plan.metadata?.requirement_id && plan.metadata.requirement_id !== requirementId)) continue;
      const explicitlyBound = plan.metadata?.requirement_id === requirementId;
      for (const step of plan.steps) {
        if (!step || typeof step !== 'object') return null;
        const itemId = step.metadata?.backlog_item_id || step.backlog_item_id;
        if (!explicitlyBound && !itemIds.has(itemId)) continue;
        // Stale pending/retryable counts cannot resurrect quarantined, exhausted,
        // dependency-blocked or missing item links. Unbound work needs explicit scope.
        const item = items.find(candidate => candidate.id === itemId);
        if (itemId && (!item || !hasRunnableBacklogWork([...doneItems, item], limits))) continue;
        if (step.infrastructure_intervention_required || step.infra_retry_after ||
            step.metadata?.repair_run?.status === 'exhausted' ||
            step.metadata?.no_progress_adjudication?.state === 'requested') continue;
        if (countPendingPlanSteps([step]) > 0) hasRunnablePlanWork = true;
      }
    }
  }
  const blockers = items
    .filter(item => item.status !== 'done')
    .flatMap(item => Array.isArray(item.blocked_by) ? item.blocked_by : [])
    .filter(blocker => blocker && isCustomerDecisionBlocker(blocker));
  return {
    userDecisionBlockers: sanitizeHarnessData(Array.from(new Map(blockers.map(blocker => [blocker.blocker_id, blocker])).values())) as BacklogBlocker[],
    technicalReviewRequired: technicalReviewBacklogItems(items, limits).length > 0,
    hasRunnableBacklogWork: hasRunnableBacklogWork(items, limits),
    hasRunnablePlanWork,
  };
}