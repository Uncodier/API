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
}

export interface SanitizationPlan {
  needsSanitization: boolean;
  itemsToReopen: SanitizationItem[];
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

  for (const item of req.backlog.items as BacklogItem[]) {
    const isCore = (item.tier ?? 'core') === 'core';
    const hasToolFailures = item.tool_failures && Object.keys(item.tool_failures).length > 0;
    
    // Check recent assumptions for plumbing keywords
    const recentAssumptions = (item.assumptions || []).slice(-3).join(' ').toLowerCase();
    const hasPlumbingAssumption = recentAssumptions.includes('[plumbing]') || 
                                 recentAssumptions.includes('serialization') ||
                                 recentAssumptions.includes('empty plan') ||
                                 recentAssumptions.includes('reverting');

    const hasPlumbingSignal = hasToolFailures || hasPlumbingAssumption;

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
          reason: `[auto-saneo] Reverted fake-done: item marked done without valid evidence while showing plumbing errors`,
          isFakeDone: true,
          isPlumbingStuck: false
        });
      }
    }
    
    // 2. Detect Plumbing-stuck items (Any tier)
    if (item.status === 'in_progress' && hasPlumbingSignal) {
      plan.itemsToReopen.push({
        id: item.id,
        title: item.title,
        previousStatus: item.status,
        reason: `[auto-saneo] Freed stuck item: stuck in_progress with plumbing errors`,
        isFakeDone: false,
        isPlumbingStuck: true
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
        status: 'pending',
        attempts: 0,
        assumptions: [...(item.assumptions || []), sanitization.reason].slice(-20),
        updated_at: new Date().toISOString()
      };
      itemsChanged++;

      // Cancel any garbage plans connected to this item
      try {
        await cancelPlanStepsForBacklogItem({
          itemId: item.id,
          reason: `[auto-saneo] Cancelling plans for unhealthy item ${item.id}`
        });
      } catch (e) {
        console.warn(`[AutoSaneo] Failed to cancel plans for item ${item.id}`, e);
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

    await supabaseAdmin.from('requirements').update({
      status: 'in-progress',
      metadata: updatedMetadata,
      updated_at: new Date().toISOString()
    }).eq('id', reqId);

    // Record the sanitization event
    await supabaseAdmin.from('requirement_status').insert({
      requirement_id: reqId,
      stage: 'in-progress',
      message: `[auto-saneo] Reverted requirement to in-progress. Sanitized ${itemsChanged} unhealthy items (fake-done or plumbing-stalled).`
    });

    console.log(`[AutoSaneo] Successfully sanitized requirement ${reqId}, reopened ${itemsChanged} items.`);
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
    .select('id, backlog')
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
