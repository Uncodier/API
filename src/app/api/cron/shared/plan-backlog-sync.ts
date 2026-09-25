import type { Sandbox } from '@vercel/sandbox';
import {
  getBacklogItem,
  hasApprovedJudgeEvidence,
  setItemStatus,
} from '@/lib/services/requirement-backlog';
import { runArchetypePostGate, type PostGateGateSignals } from './step-archetype-postgate';
import { logCronInfrastructureEvent, CronInfraEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { appendPlanRepairStepAtomically } from '@/lib/services/instance-plan-infrastructure-state';

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
  const completedStepByItemId = new Map<string, any>();

  for (const step of plan.steps) {
    const id = step.metadata?.backlog_item_id || step.backlog_item_id;
    if (id) itemIds.add(id);
    
    // Keep the completed producer step scoped to its own backlog item.
    if (step.status === 'completed') {
      if (id) completedStepByItemId.set(id, step);
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
  const errors: Error[] = [];

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

      if (hasApprovedJudgeEvidence(item)) {
        await setItemStatus({
          requirementId,
          itemId,
          status: 'done',
        });
        results.push({ itemId, action: 'completed_from_evidence' });
        continue;
      }

      // 4. Evaluate open items
      const completedStep = completedStepByItemId.get(itemId);
      if (sandbox && completedStep?.id) {
        console.log(`[PlanBacklogSync] Running Archetype Post-Gate for open item ${itemId} (plan ${plan.id} completed)`);
        
        const evalResult = await runArchetypePostGate({
          sandbox,
          requirementId,
          backlogItemId: itemId,
          stepId: completedStep.id,
          signals: signals || {},
          capturedAt: new Date().toISOString(),
          audit: audit || {} as any,
          repairRun: completedStep.metadata?.repair_run,
        });

        if (!evalResult.ran) {
          throw new Error(
            evalResult.error || `Post-gate evaluation unavailable for ${itemId}`,
          );
        }
        if (evalResult.judge_verdict === 'approved') {
          await setItemStatus({ requirementId, itemId, status: 'done' });
          results.push({ itemId, action: 'completed', verdict: 'approved' });
        } else {
          if (
            evalResult.repair_planned &&
            evalResult.repair_planned.status !== 'exhausted' &&
            !Number.isInteger(completedStep.infrastructure_generation)
          ) {
            throw new Error(
              'Cannot persist repair run without infrastructure generation',
            );
          }
          if (
            evalResult.repair_planned &&
            evalResult.repair_planned.status !== 'exhausted' &&
            Number.isInteger(completedStep.infrastructure_generation)
          ) {
            const repairRun = evalResult.repair_planned;
            const repairStepId =
              `repair_${repairRun.repair_run_id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            const mutation = await appendPlanRepairStepAtomically({
              planId: plan.id,
              sourceStepId: completedStep.id,
              expectedSourceGeneration: completedStep.infrastructure_generation,
              repairRunId: repairRun.repair_run_id,
              repairStep: {
                id: repairStepId,
                order: Math.max(
                  0,
                  ...(plan.steps || []).map((step) => Number(step.order || 0)),
                ) + 1,
                title: `Repair rejected acceptance for ${completedStep.title || itemId}`,
                instructions: repairRun.actions
                  .map((action) => action.instruction)
                  .join('\n'),
                role: completedStep.role || 'qa',
                skill: completedStep.skill,
                requires_sandbox: true,
                metadata: {
                  backlog_item_id: itemId,
                  repair_source_step_id: completedStep.id,
                  repair_run: repairRun,
                },
              },
            });
            if (!mutation.persisted) {
              throw new Error(
                `Repair run persistence rejected (${mutation.state})`,
              );
            }
          }
          results.push({
            itemId,
            action: 'evaluated',
            verdict: evalResult.judge_verdict,
            healing: evalResult.healing_applied,
          });
        }
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
      errors.push(e instanceof Error ? e : new Error(String(e)));
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
  if (errors.length > 0) {
    throw new Error(
      `Plan/backlog reconciliation failed: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
}
