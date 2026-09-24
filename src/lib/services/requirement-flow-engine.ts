/**
 * Flow engine — thin functions the orchestrator uses to decide "what's next"
 * given a requirement + its backlog. Stateless: reads DB/metadata, returns
 * pure results. All mutations go through `requirement-backlog.ts`.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  classifyRequirementType,
  getFlow,
  advancePhaseIfReadyInMemory,
  productAttemptLimits,
  type FlowDefinition,
  type FlowPhase,
  type RequirementKind,
} from './requirement-flows';
import { listBacklog, isBacklogComplete, outstandingGatingItems, isItemTerminal, type BacklogItem } from './requirement-backlog';
import { mutateBacklogAtomically } from './requirement-backlog-mutation';
import {
  isBacklogItemBlocked,
  isBacklogItemRunnable,
  requiresUserAction,
} from './requirement-backlog-blockers';

// `advancePhaseIfReadyInMemory` is re-exported from './requirement-flows' so
// the backlog module can import it without creating a cycle with this file.
export { advancePhaseIfReadyInMemory };

export interface ResolvedFlow {
  kind: RequirementKind;
  flow: FlowDefinition;
}

export async function resolveFlow(requirementId: string): Promise<ResolvedFlow> {
  const { data } = await supabaseAdmin.from('requirements').select('type').eq('id', requirementId).maybeSingle();
  const kind = classifyRequirementType(data?.type);
  return { kind, flow: getFlow(kind) };
}

export function currentPhase(flow: FlowDefinition, phaseId: string | null | undefined): FlowPhase {
  if (!phaseId) return flow.phases[0];
  return flow.phases.find((p) => p.id === phaseId) ?? flow.phases[0];
}

export function nextPhase(flow: FlowDefinition, currentPhaseId: string): FlowPhase | null {
  const idx = flow.phases.findIndex((p) => p.id === currentPhaseId);
  if (idx < 0 || idx >= flow.phases.length - 1) return null;
  return flow.phases[idx + 1];
}

export async function nextPendingItems(requirementId: string, limit: number = 3): Promise<{
  flow: FlowDefinition;
  phase: FlowPhase;
  inProgress: BacklogItem | null;
  pending: BacklogItem[];
  totalPending: number;
  totalDone: number;
  total: number;
}> {
  const { backlog, kind } = await listBacklog(requirementId);
  const flow = getFlow(kind);
  const phase = currentPhase(flow, backlog.current_phase_id);
  const completedIds = new Set(
    backlog.items
      .filter((item) => item.status === 'done')
      .map((item) => item.id),
  );
  const pending = backlog.items.filter(
    (item) =>
      item.phase_id === phase.id &&
      isBacklogItemRunnable(
        item,
        completedIds,
        productAttemptLimits(flow),
      ),
  );
  const inProgress = backlog.items.find((i) => i.status === 'in_progress') ?? null;
  return {
    flow,
    phase,
    inProgress,
    pending: pending.slice(0, limit),
    totalPending: pending.length,
    totalDone: backlog.items.filter((i) => i.status === 'done').length,
    total: backlog.items.length,
  };
}

export async function shouldAdvancePhase(requirementId: string): Promise<{ advance: boolean; from: FlowPhase; to: FlowPhase | null }> {
  const { backlog, kind } = await listBacklog(requirementId);
  const flow = getFlow(kind);
  const phase = currentPhase(flow, backlog.current_phase_id);
  const pendingInPhase = backlog.items.filter(
    (item) =>
      item.phase_id === phase.id &&
      (
        !isBacklogItemBlocked(item) ||
        requiresUserAction(item)
      ) &&
      (
        item.status === 'pending' ||
        item.status === 'in_progress' ||
        item.status === 'critic_review' ||
        item.status === 'judge_review'
      ),
  );
  if (pendingInPhase.length > 0) {
    return { advance: false, from: phase, to: null };
  }
  const nxt = nextPhase(flow, phase.id);
  return { advance: !!nxt, from: phase, to: nxt };
}

export async function advancePhaseIfReady(requirementId: string): Promise<{ advanced: boolean; to: FlowPhase | null }> {
  return mutateBacklogAtomically<{
    advanced: boolean;
    to: FlowPhase | null;
  }>(requirementId, ({ backlog, flow }) => {
    const advance = advancePhaseIfReadyInMemory(backlog, flow);
    if (!advance) {
      return {
        result: { advanced: false, to: null },
        write: false,
      };
    }
    return {
      result: { advanced: true, to: advance.to },
      backlog: advance.nextBacklog,
    };
  });
}

/**
 * Phase 10 guardrail: block requirement closure while any core item is
 * unfinished. Callers (status-sync, cron-watchers) MUST await this before
 * flipping `requirements.status = 'completed'`.
 */
export async function canCloseRequirement(requirementId: string): Promise<{
  ok: boolean;
  reason?: string;
  pending_core: BacklogItem[];
}> {
  const { backlog } = await listBacklog(requirementId);
  if (backlog.items.length === 0) {
    return { ok: false, reason: 'backlog empty — seed it before closing', pending_core: [] };
  }
  const allPending = backlog.items.filter((i) => !isItemTerminal(i.status) && i.status !== 'rejected');
  if (allPending.length > 0) {
    return {
      ok: false,
      reason: `${allPending.length} item(s) still pending (including ornamental): ${allPending.slice(0, 3).map((i) => i.title).join(' | ')}${allPending.length > 3 ? ' …' : ''}`,
      pending_core: allPending,
    };
  }
  if (!isBacklogComplete(backlog.items)) {
    return { ok: false, reason: 'no gating items or not all gating items done', pending_core: [] };
  }
  return { ok: true, pending_core: [] };
}
