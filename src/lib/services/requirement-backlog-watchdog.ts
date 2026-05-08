/**
 * Backlog lifecycle watchdog. These helpers run at the start of each cron
 * cycle (in `cron-orchestrator-step.ts`) to keep the backlog healthy
 * regardless of orchestrator drift:
 *
 *   - bumpItemAttempts             — increment attempts on Judge rejection
 *                                    so the deterministic self-heal policy
 *                                    eventually escalates to needs_review.
 *   - escalateStaleInProgressItems — auto-escalate in_progress items that
 *                                    burned their idle/attempts envelope to
 *                                    needs_review (phase-terminal).
 *   - ensureInProgressItem         — backlog-side WIP=1 guarantee: if there
 *                                    is no in_progress and unblocked pending
 *                                    items remain, promote the next one
 *                                    server-side instead of waiting for the
 *                                    coordinator to remember `start`.
 *   - resolveBacklogContextForInstance — used by the instance_plan tool to
 *                                    auto-bind metadata.backlog_item_id on
 *                                    plan steps when the orchestrator
 *                                    forgot to pass it.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  classifyRequirementType,
  getFlow,
  advancePhaseIfReadyInMemory,
} from './requirement-flows';
import type { BacklogItem } from './requirement-backlog-types';
import {
  computeRatio,
  loadRequirement,
  reconcilePhaseForItem,
  toBacklog,
  writeBacklog,
} from './requirement-backlog-store';
import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';

export async function bumpItemAttempts(params: {
  requirementId: string;
  itemId: string;
  reason?: string;
}): Promise<BacklogItem | null> {
  const req = await loadRequirement(params.requirementId);
  if (!req) return null;
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');
  const idx = backlog.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) return null;
  backlog.items[idx] = {
    ...backlog.items[idx],
    attempts: (backlog.items[idx].attempts || 0) + 1,
    updated_at: new Date().toISOString(),
  };
  if (params.reason) {
    const assumptions = backlog.items[idx].assumptions || [];
    backlog.items[idx].assumptions = [...assumptions, params.reason].slice(-20);
  }
  await writeBacklog(params.requirementId, backlog);
  return backlog.items[idx];
}

const DEFAULT_STALE_IN_PROGRESS_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function escalateStaleInProgressItems(params: {
  requirementId: string;
  maxIdleMs?: number;
  maxAttempts?: number;
}): Promise<{ escalated: BacklogItem[] }> {
  const req = await loadRequirement(params.requirementId);
  if (!req) return { escalated: [] };
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');
  const now = Date.now();
  const idleMs = params.maxIdleMs ?? DEFAULT_STALE_IN_PROGRESS_MS;
  const maxAttempts = params.maxAttempts ?? flow.cost_envelope.max_cycles_per_item;
  const escalated: BacklogItem[] = [];

  for (let i = 0; i < backlog.items.length; i++) {
    const it = backlog.items[i];
    if (it.status !== 'in_progress') continue;
    const updatedMs = it.updated_at ? Date.parse(it.updated_at) : NaN;
    const idle = Number.isFinite(updatedMs) ? now - updatedMs : Infinity;
    const overAttempts = (it.attempts || 0) >= maxAttempts;
    if (idle < idleMs && !overAttempts) continue;
    const note = `[watchdog] auto-escalated to needs_review after idle=${Math.round(idle / 60000)}m attempts=${it.attempts ?? 0} (thresholds idle_min=${Math.round(idleMs / 60000)} max_attempts=${maxAttempts})`;
    backlog.items[i] = {
      ...it,
      status: 'needs_review',
      updated_at: new Date().toISOString(),
      assumptions: [...(it.assumptions || []), note].slice(-20),
    };
    escalated.push(backlog.items[i]);
  }

  if (escalated.length === 0) return { escalated };

  backlog.completion_ratio = computeRatio(backlog.items);
  const advance = advancePhaseIfReadyInMemory(backlog, flow);
  const toWrite = advance ? advance.nextBacklog : backlog;
  await writeBacklog(params.requirementId, toWrite);

  // Stop the zombie loop: when a backlog item is escalated to needs_review,
  // any plan steps still pending/in_progress for that item must be cancelled.
  // Otherwise `cron-execute-steps-phase` keeps running them in the next tick
  // and the agent burns turns trying to finish work whose acceptance gate is
  // no longer reachable (observed on item 8afbb973: 10 attempts, plan
  // 031a9346 still in_progress after the watchdog escalated the item).
  for (const it of escalated) {
    try {
      const r = await cancelPlanStepsForBacklogItem({
        itemId: it.id,
        reason: `watchdog escalated backlog item to needs_review (idle/attempts envelope exhausted)`,
      });
      if (r.stepsCancelled > 0) {
        console.warn(
          `[watchdog] cancelled ${r.stepsCancelled} plan step(s) across ${r.plansTouched} plan(s) bound to escalated item ${it.id} (plansCancelled=${r.plansCancelled})`,
        );
      }
    } catch (e) {
      console.warn(`[watchdog] cancelPlanStepsForBacklogItem failed for ${it.id}:`, e);
    }
  }
  return { escalated };
}

export async function ensureInProgressItem(params: {
  requirementId: string;
}): Promise<{ promoted: BacklogItem | null; reason: string }> {
  const req = await loadRequirement(params.requirementId);
  if (!req) return { promoted: null, reason: 'requirement_not_found' };
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');

  const active = backlog.items.find((i) => i.status === 'in_progress');
  if (active) return { promoted: null, reason: 'already_in_progress' };

  const phaseId = backlog.current_phase_id || flow.phases[0]?.id || '';
  const terminalIds = new Set(
    backlog.items
      .filter((i) => i.status === 'done' || i.status === 'needs_review')
      .map((i) => i.id),
  );
  const isUnblocked = (it: BacklogItem): boolean => {
    const deps = it.depends_on ?? [];
    return deps.every((d) => terminalIds.has(d));
  };
  const candidates = backlog.items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it.status === 'pending' && isUnblocked(it));

  if (candidates.length === 0) {
    return { promoted: null, reason: 'no_pending_unblocked' };
  }

  const phaseIndex = (id: string): number => {
    const i = flow.phases.findIndex((p) => p.id === id);
    return i >= 0 ? i : flow.phases.length + 1;
  };
  const curIdx = phaseIndex(phaseId);
  candidates.sort((a, b) => {
    const aPhase = phaseIndex(a.it.phase_id);
    const bPhase = phaseIndex(b.it.phase_id);
    // Items in current phase first; then forward phases; then earlier phases.
    const aDist = aPhase >= curIdx ? aPhase - curIdx : aPhase + flow.phases.length;
    const bDist = bPhase >= curIdx ? bPhase - curIdx : bPhase + flow.phases.length;
    if (aDist !== bDist) return aDist - bDist;
    const aTier = (a.it.tier ?? 'core') === 'core' ? 0 : 1;
    const bTier = (b.it.tier ?? 'core') === 'core' ? 0 : 1;
    if (aTier !== bTier) return aTier - bTier;
    return a.idx - b.idx;
  });

  const pick = candidates[0];
  const note = `[watchdog] auto-started — no in_progress item with ${candidates.length} pending unblocked`;
  backlog.items[pick.idx] = {
    ...pick.it,
    status: 'in_progress',
    attempts: (pick.it.attempts || 0) + 1,
    updated_at: new Date().toISOString(),
    assumptions: [...(pick.it.assumptions || []), note].slice(-20),
  };
  reconcilePhaseForItem(backlog, flow, backlog.items[pick.idx]);
  await writeBacklog(params.requirementId, backlog);
  return { promoted: backlog.items[pick.idx], reason: 'auto_started' };
}

export async function resolveBacklogContextForInstance(instanceId: string): Promise<{
  requirementId: string | null;
  inProgressItemId: string | null;
}> {
  if (!instanceId) return { requirementId: null, inProgressItemId: null };
  const { data: row } = await supabaseAdmin
    .from('requirement_status')
    .select('requirement_id')
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const requirementId = row?.requirement_id ?? null;
  if (!requirementId) return { requirementId: null, inProgressItemId: null };
  try {
    const req = await loadRequirement(requirementId);
    if (!req) return { requirementId, inProgressItemId: null };
    const flow = getFlow(classifyRequirementType(req.type));
    const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');
    const inProgress = backlog.items.filter((i) => i.status === 'in_progress');
    return {
      requirementId,
      inProgressItemId: inProgress.length === 1 ? inProgress[0].id : null,
    };
  } catch {
    return { requirementId, inProgressItemId: null };
  }
}
