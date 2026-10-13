import { mutateBacklogAtomically } from './requirement-backlog-mutation';
import {
  assertBacklogInvariants,
  assertBacklogStatusTransition,
  isBacklogActiveStatus,
} from './requirement-backlog-invariants';
import { productAttemptLimits } from './requirement-flows';
import { reconcilePhaseForItem } from './requirement-backlog-store';
import {
  evaluatePlanBacklogGate,
  type PlanBacklogGate,
} from './requirement-plan-backlog-gate';

/** Called by the owned cron executor, never by a client or a planning agent. */
export async function admitPendingPlanBacklogItem(
  requirementId: string,
  step: Record<string, any>,
): Promise<PlanBacklogGate> {
  return mutateBacklogAtomically<PlanBacklogGate>(requirementId, ({ requirement, backlog, flow }) => {
    const gate = evaluatePlanBacklogGate(step, backlog.items);
    const itemId = gate.itemId;
    const item = backlog.items.find(candidate => candidate.id === itemId);
    const deny = (reason: 'backlog_item_not_active' | 'backlog_item_blocked'): PlanBacklogGate =>
      ({ runnable: false, reason, itemId });

    // Recheck lifecycle and protections on every CAS retry; never reopen a hold.
    if (!['backlog', 'in-progress'].includes(requirement.status || '') || requirement.metadata?.execution_hold) {
      return { result: deny('backlog_item_not_active'), write: false };
    }
    if (gate.runnable || !item || item.status !== 'pending' || gate.reason !== 'backlog_item_not_active') {
      return { result: gate, write: false };
    }
    const completedIds = new Set(backlog.items.filter(candidate => candidate.status === 'done').map(candidate => candidate.id));
    if ((item.depends_on || []).some(id => !completedIds.has(id))) {
      return { result: deny('backlog_item_blocked'), write: false };
    }
    if (backlog.items.some(candidate => candidate.id !== item.id && isBacklogActiveStatus(candidate.status))) {
      return { result: deny('backlog_item_not_active'), write: false };
    }
    const limits = productAttemptLimits(flow);
    if ((item.attempts || 0) >= ((item.tier ?? 'core') === 'ornamental' ? limits.ornamental : limits.core)) {
      return { result: deny('backlog_item_not_active'), write: false };
    }

    assertBacklogStatusTransition(backlog.items, item.id, 'in_progress');
    item.status = 'in_progress';
    item.updated_at = new Date().toISOString();
    reconcilePhaseForItem(backlog, flow, item);
    assertBacklogInvariants(backlog.items, flow.phases.map(phase => phase.id));
    // Admission is not a product attempt and does not change step/retry state.
    return { result: evaluatePlanBacklogGate(step, backlog.items) };
  });
}