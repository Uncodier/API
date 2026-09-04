import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadRequirement, toBacklog, writeBacklog } from './requirement-backlog-store';
import { getFlow, classifyRequirementType } from './requirement-flows';
import { isBacklogComplete } from './requirement-backlog';
import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';
import type { BacklogItem } from './requirement-backlog-types';

export interface SanitizationItem {
  id: string;
  title: string;
  previousStatus: string;
  reason: string;
  isFakeDone: boolean;
  isPlumbingStuck: boolean;
  targetStatus: 'pending' | 'needs_review';
}

export interface SanitizationPlan {
  needsSanitization: boolean;
  itemsToReopen: SanitizationItem[];
}

export function requirementStatusAfterSaneo(
  items: Array<{ status?: string | null }>,
): { status: 'in-progress' | 'on-review'; stage: 'in-progress' | 'needs_review' } {
  const runnable = items.some((i) => i.status === 'pending' || i.status === 'in_progress');
  return runnable
    ? { status: 'in-progress', stage: 'in-progress' }
    : { status: 'on-review', stage: 'needs_review' };
}

export interface SanitizationSummary {
  requirementsChecked: number;
  requirementsSanitized: number;
  itemsReopened: number;
}

/**
 * Checks a requirement's backlog to find items that are either:
 * 1. Fake-done: Core items marked 'done' without valid Judge evidence AND showing plumbing stall signals
 * 2. Plumbing-stalled: Items 'in_progress' stuck with plumbing tool failures
 */
export function detectUnhealthyOnReview(req: any): SanitizationPlan {
  const plan: SanitizationPlan = { needsSanitization: false, itemsToReopen: [] };
  
  if (!req || !req.backlog || !Array.isArray(req.backlog.items)) {
    return plan;
  }

  const maxReopens = parseInt(process.env.ONREVIEW_SANITIZE_MAX_REOPENS || '2', 10);

  for (const item of req.backlog.items as BacklogItem[]) {
    const isCore = (item.tier ?? 'core') === 'core';
    const failureKeys = Object.keys(item.tool_failures || {});
    const ignorableKeys = failureKeys.filter((k) =>
      /^(unknown|instance_plan|execute_step)$/i.test(k),
    );
    const realToolFailures = failureKeys.filter((k) => !/^(unknown|instance_plan|execute_step)$/i.test(k));
    const hasToolFailures = realToolFailures.length > 0;
    
    const recentAssumptions = (item.assumptions || []).slice(-5).join(' ').toLowerCase();
    
    const hasInfraAssumption = recentAssumptions.includes('insufficient credits') ||
                               recentAssumptions.includes('sandbox vm crashed') ||
                               recentAssumptions.includes('vm has crashed') ||
                               recentAssumptions.includes('410 gone');

    const hasSchemaNoise = recentAssumptions.includes('execute_step') ||
      recentAssumptions.includes('missing required field') ||
      ignorableKeys.length > 0;

    const hasPlumbingAssumption = !hasSchemaNoise && (
      recentAssumptions.includes('[plumbing]') ||
      recentAssumptions.includes('serialization') ||
      recentAssumptions.includes('empty plan')
    );

    const productAdvancing = (item.touches || []).some((t) => /^docs\//.test(t)) ||
      recentAssumptions.includes('[rotate]') ||
      recentAssumptions.includes('docs/');

    const hasPlumbingSignal = !productAdvancing && (hasToolFailures || hasPlumbingAssumption || hasInfraAssumption);
    
    // Count previous sanitizations
    const reopenCount = (item.assumptions || []).filter(a => a.includes('[auto-saneo]')).length;

    // Determine target status
    let targetStatus: 'pending' | 'needs_review' = 'pending';
    let targetReason = '';

    if (hasInfraAssumption) {
      targetStatus = 'needs_review';
      targetReason = `[auto-saneo] escalated to needs_review: stuck with sandbox infra errors (not agent-fixable)`;
    } else if (reopenCount >= maxReopens) {
      targetStatus = 'needs_review';
      targetReason = `[auto-saneo] escalated to needs_review: reached max reopens (${reopenCount}/${maxReopens}) without progress`;
    }

    // 1. Detect Fake-done (Core only)
    if (item.status === 'done' && isCore) {
      const ev = item.evidence;
      const isJudgeApproved = ev?.judge_verdict === 'approved';
      const hasAnyGateSignal = !!(ev?.build || ev?.runtime || ev?.tests?.length || ev?.scenarios?.length);
      
      if (!isJudgeApproved && !hasAnyGateSignal && hasPlumbingSignal) {
        plan.itemsToReopen.push({
          id: item.id,
          title: item.title,
          previousStatus: item.status,
          reason: targetStatus === 'needs_review' ? targetReason : `[auto-saneo] Reverted fake-done: item marked done without valid evidence while showing plumbing errors`,
          isFakeDone: true,
          isPlumbingStuck: false,
          targetStatus
        });
      }
    }
    
    // 2. Detect Plumbing-stuck items (Any tier)
    if (item.status === 'in_progress' && hasPlumbingSignal) {
      plan.itemsToReopen.push({
        id: item.id,
        title: item.title,
        previousStatus: item.status,
        reason: targetStatus === 'needs_review' ? targetReason : `[auto-saneo] Freed stuck item: stuck in_progress with plumbing errors`,
        isFakeDone: false,
        isPlumbingStuck: true,
        targetStatus
      });
    }
  }

  if (plan.itemsToReopen.length > 0) {
    plan.needsSanitization = true;
  }

  return plan;
}

/**
 * Applies the sanitization plan to a requirement:
 * - Updates item statuses and logs assumptions
 * - Cancels stuck garbage plans
 * - Reverts requirement status to 'in-progress' and resets cron counters
 */
export async function applyOnReviewSanitization(reqId: string, plan: SanitizationPlan): Promise<void> {
  if (!plan.needsSanitization) return;

  const req = await loadRequirement(reqId);
  if (!req) return;

  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');
  let itemsChanged = 0;

  for (const sanitization of plan.itemsToReopen) {
    const idx = backlog.items.findIndex(i => i.id === sanitization.id);
    if (idx >= 0) {
      const item = backlog.items[idx];
      backlog.items[idx] = {
        ...item,
        status: sanitization.targetStatus,
        // PRESERVE attempts instead of resetting to 0
        attempts: item.attempts || 0,
        assumptions: [...(item.assumptions || []), sanitization.reason].slice(-20),
        updated_at: new Date().toISOString()
      };
      itemsChanged++;

      // Keep in_progress plans alive so finalize does not see "plan not completed"
      // and the instance is not left pending with no active plan. Only cancel when
      // we escalate to needs_review (human takeover).
      if (sanitization.targetStatus === 'needs_review') {
        try {
          await cancelPlanStepsForBacklogItem({
            itemId: item.id,
            reason: `[auto-saneo] Cancelling plans for unhealthy item ${item.id} (transitioning to ${sanitization.targetStatus})`
          });
        } catch (e) {
          console.warn(`[AutoSaneo] Failed to cancel plans for item ${item.id}`, e);
        }
      }
    }
  }

  if (itemsChanged > 0) {
    // Reset requirement metadata
    const metadata = req.metadata || {};
    const updatedMetadata = {
      ...metadata,
      cron_attempts: 0,
      all_done_cycles: 0,
      has_completed_backlog: false,
      last_sanitized_at: new Date().toISOString()
    };

    await writeBacklog(reqId, backlog);

    const next = requirementStatusAfterSaneo(backlog.items);
    await supabaseAdmin.from('requirements').update({
      status: next.status,
      metadata: updatedMetadata,
      updated_at: new Date().toISOString()
    }).eq('id', reqId);

    // Record the sanitization event
    try {
      await supabaseAdmin.from('requirement_status').insert({
        requirement_id: reqId,
        site_id: req.site_id || null,
        instance_id: req.metadata?.runner_instance_id || null,
        stage: next.stage,
        message: next.status === 'on-review'
          ? `[auto-saneo] Escalated to on-review (needs_review). Sanitized ${itemsChanged} item(s); nothing left runnable.`
          : `[auto-saneo] Reverted requirement to in-progress. Sanitized ${itemsChanged} unhealthy items (fake-done or plumbing-stalled).`
      });
    } catch (err) {
      console.error(`[AutoSaneo] Failed to record requirement_status for ${reqId}:`, err);
    }

    console.log(`[AutoSaneo] Successfully sanitized requirement ${reqId}, reopened ${itemsChanged} items.`);

    const pendingItems = plan.itemsToReopen.filter((i) => i.targetStatus === 'pending');
    if (pendingItems.length > 0) {
      try {
        const { ensureActivePlanAfterSaneo } = await import('@/lib/services/saneo-recovery-plan');
        await ensureActivePlanAfterSaneo({
          requirementId: reqId,
          instanceId: req.metadata?.runner_instance_id,
          siteId: req.site_id,
          reopenedItemIds: pendingItems.map((i) => i.id),
        });
      } catch (e) {
        console.warn('[AutoSaneo] Failed to ensure recovery plan:', e);
      }
    }
  }
}

/**
 * Main cron hook: Scans recent 'on-review' requirements and sanitizes unhealthy ones.
 */
export async function runOnReviewSanitization(): Promise<SanitizationSummary> {
  const summary: SanitizationSummary = {
    requirementsChecked: 0,
    requirementsSanitized: 0,
    itemsReopened: 0
  };

  const windowDays = parseInt(process.env.ONREVIEW_SANITIZE_WINDOW_DAYS || '7', 10);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);

  const { data: reqs, error } = await supabaseAdmin
    .from('requirements')
    .select('id, site_id, metadata, backlog')
    .eq('status', 'on-review')
    .gte('updated_at', cutoffDate.toISOString())
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error || !reqs || reqs.length === 0) {
    return summary;
  }

  summary.requirementsChecked = reqs.length;

  for (const req of reqs) {
    const plan = detectUnhealthyOnReview(req);
    if (plan.needsSanitization) {
      await applyOnReviewSanitization(req.id, plan);
      summary.requirementsSanitized++;
      summary.itemsReopened += plan.itemsToReopen.length;
    }
  }

  return summary;
}
