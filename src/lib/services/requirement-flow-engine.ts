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
  type FlowDefinition,
  type FlowPhase,
  type RequirementKind,
} from './requirement-flows';
import { listBacklog, coreItemsAllDone, pendingCoreItems, type BacklogItem } from './requirement-backlog';

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
  const pending = backlog.items.filter((i) => i.phase_id === phase.id && i.status === 'pending');
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
    (i) => i.phase_id === phase.id && (i.status === 'pending' || i.status === 'in_progress' || i.status === 'critic_review' || i.status === 'judge_review'),
  );
  if (pendingInPhase.length > 0) {
    return { advance: false, from: phase, to: null };
  }
  const nxt = nextPhase(flow, phase.id);
  return { advance: !!nxt, from: phase, to: nxt };
}

export async function advancePhaseIfReady(requirementId: string): Promise<{ advanced: boolean; to: FlowPhase | null }> {
  const decision = await shouldAdvancePhase(requirementId);
  if (!decision.advance || !decision.to) {
    return { advanced: false, to: decision.to };
  }
  const { data } = await supabaseAdmin
    .from('requirements')
    .select('backlog')
    .eq('id', requirementId)
    .maybeSingle();
  const backlog = ((data?.backlog as Record<string, any>) || {}) as Record<string, any>;
  backlog.current_phase_id = decision.to.id;
  await supabaseAdmin.from('requirements').update({ backlog }).eq('id', requirementId);
  return { advanced: true, to: decision.to };
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
  const pending = pendingCoreItems(backlog.items);
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `${pending.length} core item(s) still pending: ${pending.slice(0, 3).map((i) => i.title).join(' | ')}${pending.length > 3 ? ' …' : ''}`,
      pending_core: pending,
    };
  }
  if (!coreItemsAllDone(backlog.items)) {
    return { ok: false, reason: 'no core items or not all core items done', pending_core: [] };
  }
  return { ok: true, pending_core: [] };
}
