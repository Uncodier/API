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
  productAttemptLimits,
} from './requirement-flows';
import type { BacklogItem } from './requirement-backlog-types';
import {
  computeRatio,
  loadRequirement,
  reconcilePhaseForItem,
  toBacklog,
} from './requirement-backlog-store';
import { mutateBacklogAtomically } from './requirement-backlog-mutation';
import {
  assertBacklogInvariants,
  isBacklogActiveStatus,
} from './requirement-backlog-invariants';
import { patchRequirementMetadataKeys } from './requirement-metadata-patch';
import {
  isBacklogItemBlocked,
  releaseDueAutomaticBlockers,
} from './requirement-backlog-blockers';
import {
  fulfillPlanCancellationRequests,
  pendingPlanCancellation,
  requestPlanCancellation,
  type PendingPlanCancellation,
} from './requirement-plan-cancellation';

export async function bumpItemAttempts(params: {
  requirementId: string;
  itemId: string;
  reason?: string;
}): Promise<BacklogItem | null> {
  return mutateBacklogAtomically(
    params.requirementId,
    ({ backlog }) => {
      const idx = backlog.items.findIndex((item) => item.id === params.itemId);
      if (idx < 0) return { result: null, write: false };
      backlog.items[idx] = {
        ...backlog.items[idx],
        attempts: (backlog.items[idx].attempts || 0) + 1,
        updated_at: new Date().toISOString(),
      };
      if (params.reason) {
        const assumptions = backlog.items[idx].assumptions || [];
        backlog.items[idx].assumptions = [...assumptions, params.reason].slice(-20);
      }
      return { result: backlog.items[idx] };
    },
    { onMissing: () => null },
  );
}

export async function recordToolFailure(params: {
  requirementId: string;
  itemId: string;
  toolName: string;
  reason?: string;
}): Promise<BacklogItem | null> {
  const mutation = await mutateBacklogAtomically<{
    item: BacklogItem | null;
    metadata: Record<string, any> | null;
  }>(
    params.requirementId,
    ({ requirement, backlog }) => {
      const idx = backlog.items.findIndex((item) => item.id === params.itemId);
      if (idx < 0) {
        return {
          result: { item: null, metadata: requirement.metadata },
          write: false,
        };
      }
      const failures = { ...(backlog.items[idx].tool_failures || {}) };
      failures[params.toolName] = (failures[params.toolName] || 0) + 1;
      backlog.items[idx] = {
        ...backlog.items[idx],
        tool_failures: failures,
        updated_at: new Date().toISOString(),
      };
      if (params.reason) {
        const assumptions = backlog.items[idx].assumptions || [];
        backlog.items[idx].assumptions = [...assumptions, params.reason].slice(-20);
      }
      return {
        result: { item: backlog.items[idx], metadata: requirement.metadata },
      };
    },
    { onMissing: () => ({ item: null, metadata: null }) },
  );
  if (!mutation.item) return null;

  // Telemetry: aggregate tool failures in requirement.metadata.tool_health
  try {
    const metadata: Record<string, any> = mutation.metadata || {};
    const toolHealth = metadata.tool_health || {};
    toolHealth[params.toolName] = (toolHealth[params.toolName] || 0) + 1;
    await patchRequirementMetadataKeys({
      requirementId: params.requirementId,
      patch: { tool_health: toolHealth },
    });
  } catch (err) {
    console.error(`[Watchdog] Failed to update tool_health telemetry:`, err);
  }

  return mutation.item;
}

const DEFAULT_STALE_IN_PROGRESS_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function escalateStaleInProgressItems(params: {
  requirementId: string;
  maxIdleMs?: number;
  maxAttempts?: number;
}): Promise<{ escalated: BacklogItem[] }> {
  const now = Date.now();
  const idleMs = params.maxIdleMs ?? DEFAULT_STALE_IN_PROGRESS_MS;
  const result = await mutateBacklogAtomically(
    params.requirementId,
    ({ backlog, flow }) => {
      const attemptLimits = productAttemptLimits(flow);
      const escalated: BacklogItem[] = [];
      const cancellationRequests: PendingPlanCancellation[] = backlog.items
        .map(pendingPlanCancellation)
        .filter((request): request is PendingPlanCancellation => !!request);

      for (let i = 0; i < backlog.items.length; i++) {
        const item = backlog.items[i];
        if (item.status !== 'in_progress') continue;
        const lastAssumption = item.assumptions?.at(-1) || '';
        const isIdleDueToPlumbing = lastAssumption.includes('[plumbing]');
        const updatedMs = item.updated_at ? Date.parse(item.updated_at) : NaN;
        const idle = Number.isFinite(updatedMs) ? now - updatedMs : Infinity;
        const maxAttempts =
          params.maxAttempts ??
          ((item.tier ?? 'core') === 'ornamental'
            ? attemptLimits.ornamental
            : attemptLimits.core);
        const overAttempts = (item.attempts || 0) >= maxAttempts;
        if (idle < idleMs && !overAttempts) continue;
        if (!overAttempts && isIdleDueToPlumbing) {
          console.log(
            `[Watchdog] Item ${item.id} is idle (${Math.round(idle / 60000)}m) but last assumption was plumbing. Skipping escalation.`,
          );
          continue;
        }
        const note = `[watchdog] auto-escalated to needs_review after idle=${Math.round(idle / 60000)}m attempts=${item.attempts ?? 0} (thresholds idle_min=${Math.round(idleMs / 60000)} max_attempts=${maxAttempts})`;
        const cancellationReason =
          'watchdog escalated backlog item to needs_review ' +
          '(idle/attempts envelope exhausted)';
        const cancellationRequestedAt = new Date().toISOString();
        backlog.items[i] = requestPlanCancellation({
          ...item,
          status: 'needs_review',
          updated_at: new Date().toISOString(),
          assumptions: [...(item.assumptions || []), note].slice(-20),
        }, cancellationReason, cancellationRequestedAt);
        escalated.push(backlog.items[i]);
        cancellationRequests.push({
          itemId: item.id,
          reason: cancellationReason,
          requestedAt: cancellationRequestedAt,
        });
      }
      if (escalated.length === 0) {
        return {
          result: { escalated, cancellationRequests },
          write: false,
        };
      }
      backlog.completion_ratio = computeRatio(backlog.items);
      const advance = advancePhaseIfReadyInMemory(backlog, flow);
      return {
        result: { escalated, cancellationRequests },
        backlog: advance ? advance.nextBacklog : backlog,
      };
    },
    { onMissing: () => ({ escalated: [], cancellationRequests: [] }) },
  );

  // Stop the zombie loop: when a backlog item is escalated to needs_review,
  // any plan steps still pending/in_progress for that item must be cancelled.
  // Otherwise `cron-execute-steps-phase` keeps running them in the next tick
  // and the agent burns turns trying to finish work whose acceptance gate is
  // no longer reachable (observed on item 8afbb973: 10 attempts, plan
  // 031a9346 still in_progress after the watchdog escalated the item).
  await fulfillPlanCancellationRequests({
    requirementId: params.requirementId,
    requests: result.cancellationRequests,
  });
  return { escalated: result.escalated };
}

export async function ensureInProgressItem(params: {
  requirementId: string;
}): Promise<{ promoted: BacklogItem | null; reason: string }> {
  const mutation = await mutateBacklogAtomically<{
    promoted: BacklogItem | null;
    reason: string;
    advancedTo: string | null;
  }>(
    params.requirementId,
    ({ backlog, flow }) => {
      const releasedBlockers = releaseDueAutomaticBlockers(backlog.items);
      const active = backlog.items.find((item) =>
        isBacklogActiveStatus(item.status),
      );
      if (active) {
        return {
          result: {
            promoted: null,
            reason: 'already_in_progress',
            advancedTo: null,
          },
          write: releasedBlockers.length > 0,
        };
      }

      const advance = advancePhaseIfReadyInMemory(backlog, flow);
      const workingBacklog = advance ? advance.nextBacklog : backlog;
      const phaseId =
        workingBacklog.current_phase_id || flow.phases[0]?.id || '';
      const completedIds = new Set(
        workingBacklog.items
          .filter((item) => item.status === 'done')
          .map((item) => item.id),
      );
      const candidates = workingBacklog.items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => {
          const unblocked = (item.depends_on || []).every((dependencyId) =>
            completedIds.has(dependencyId),
          );
          if (
            item.status !== 'pending' ||
            !unblocked ||
            isBacklogItemBlocked(item)
          ) {
            return false;
          }
          if ((item.tier ?? 'core') === 'ornamental') {
            const maxAttempts = parseInt(
              process.env.CRON_ORNAMENTAL_MAX_ATTEMPTS || '2',
              10,
            );
            if ((item.attempts || 0) >= maxAttempts) return false;
          }
          return true;
        });

      if (candidates.length === 0) {
        return {
          result: {
            promoted: null,
            reason: 'no_pending_unblocked',
            advancedTo: advance?.to.id || null,
          },
          backlog: workingBacklog,
          write: !!advance || releasedBlockers.length > 0,
        };
      }

      const phaseIndex = (id: string): number => {
        const index = flow.phases.findIndex((phase) => phase.id === id);
        return index >= 0 ? index : flow.phases.length + 1;
      };
      const currentPhaseIndex = phaseIndex(phaseId);
      candidates.sort((left, right) => {
        const leftPhase = phaseIndex(left.item.phase_id);
        const rightPhase = phaseIndex(right.item.phase_id);
        const leftDistance = leftPhase >= currentPhaseIndex
          ? leftPhase - currentPhaseIndex
          : leftPhase + flow.phases.length;
        const rightDistance = rightPhase >= currentPhaseIndex
          ? rightPhase - currentPhaseIndex
          : rightPhase + flow.phases.length;
        if (leftDistance !== rightDistance) return leftDistance - rightDistance;
        const leftTier = (left.item.tier ?? 'core') === 'core' ? 0 : 1;
        const rightTier = (right.item.tier ?? 'core') === 'core' ? 0 : 1;
        return leftTier !== rightTier ? leftTier - rightTier : left.idx - right.idx;
      });

      const pick = candidates[0];
      const note = `[watchdog] auto-started — no active item with ${candidates.length} pending unblocked`;
      workingBacklog.items[pick.idx] = {
        ...pick.item,
        status: 'in_progress',
        updated_at: new Date().toISOString(),
        assumptions: [...(pick.item.assumptions || []), note].slice(-20),
      };
      reconcilePhaseForItem(workingBacklog, flow, workingBacklog.items[pick.idx]);
      assertBacklogInvariants(
        workingBacklog.items,
        flow.phases.map((phase) => phase.id),
      );
      return {
        result: {
          promoted: workingBacklog.items[pick.idx],
          reason: 'auto_started',
          advancedTo: advance?.to.id || null,
        },
        backlog: workingBacklog,
      };
    },
    {
      onMissing: () => ({
        promoted: null,
        reason: 'requirement_not_found',
        advancedTo: null,
      }),
    },
  );
  if (mutation.advancedTo) {
    console.log(
      `[Watchdog] Auto-advanced phase to ${mutation.advancedTo} for requirement ${params.requirementId}`,
    );
  }
  return { promoted: mutation.promoted, reason: mutation.reason };
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
