import type { Sandbox } from '@vercel/sandbox';
import { getBacklogItem, setItemStatus } from '@/lib/services/requirement-backlog';
import { runArchetypePostGate, type PostGateGateSignals } from './step-archetype-postgate';
import { logCronInfrastructureEvent, CronInfraEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';

export interface SyncBacklogAfterPlanCompletedParams {
  requirementId: string;
  plan: {
    id: string;
    steps?: any[];
  };
  sandbox?: Sandbox;
  signals?: PostGateGateSignals;
  audit?: CronAuditContext;
}

/**
 * Safety net: when a plan reconciles to 'completed', we check if any bound
 * backlog items are still open. If they are, we trigger the Post-Gate Archetypes
 * (Critic/Judge) to evaluate them. We do not blindly close backlog items.
 */
export async function syncBacklogAfterPlanCompleted(params: SyncBacklogAfterPlanCompletedParams) {
  const { requirementId, plan, sandbox, signals, audit } = params;

  if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return;
  }

  // 1. Collect distinct bound backlog items
  const itemIds = new Set<string>();
  let lastCompletedStepId: string | undefined;

  for (const step of plan.steps) {
    const id = step.metadata?.backlog_item_id || step.backlog_item_id;
    if (id) itemIds.add(id);
    
    // We'll need a step id to pass to the archetype runner. We can use the last completed one.
    if (step.status === 'completed') {
      lastCompletedStepId = step.id;
    }
  }

  if (itemIds.size === 0) {
    if (audit) {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.PLAN_RECONCILE,
        message: `Plan ${plan.id} completed, but no steps were bound to a backlog item.`,
      });
    }
    return;
  }

  const results = [];

  // 2. Evaluate each item
  for (const itemId of Array.from(itemIds)) {
    try {
      const { item } = await getBacklogItem(requirementId, itemId);
      if (!item) continue;

      // 3. Skip terminal statuses
      if (item.status === 'done' || item.status === 'rejected' || item.status === 'needs_review') {
        results.push({ itemId, action: 'skipped', reason: `already ${item.status}` });
        continue;
      }

      // 4. Evaluate open items
      if (sandbox && lastCompletedStepId) {
        console.log(`[PlanBacklogSync] Running Archetype Post-Gate for open item ${itemId} (plan ${plan.id} completed)`);
        
        const evalResult = await runArchetypePostGate({
          sandbox,
          requirementId,
          backlogItemId: itemId,
          stepId: lastCompletedStepId,
          signals: signals || {},
          capturedAt: new Date().toISOString(),
          audit: audit || {} as any,
        });

        results.push({ 
          itemId, 
          action: 'evaluated', 
          verdict: evalResult.judge_verdict || 'unknown',
          healing: evalResult.healing_applied
        });
      } else {
        // Edge case: no live sandbox or no valid step id. Just bump to judge_review.
        console.log(`[PlanBacklogSync] No sandbox available for item ${itemId}. Bumping to judge_review.`);
        await setItemStatus({
          requirementId,
          itemId,
          status: 'judge_review',
          reason: `Plan ${plan.id} completed, awaiting sandbox for evaluation.`
        });
        results.push({ itemId, action: 'bumped_to_judge_review' });
      }
    } catch (e: any) {
      console.warn(`[PlanBacklogSync] Failed to sync item ${itemId}:`, e);
      results.push({ itemId, action: 'error', error: e.message });
    }
  }

  // 6. Log final sync
  if (audit && results.length > 0) {
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.PLAN_RECONCILE,
      message: `Plan ${plan.id} completed. Backlog sync: evaluated ${results.filter(r => r.action === 'evaluated').length} items.`,
      details: { results }
    });
  }
}
