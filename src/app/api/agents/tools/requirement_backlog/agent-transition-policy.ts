import type { BacklogItemStatus } from '@/lib/services/requirement-backlog';

const RUNNER_OWNED_STATUSES = new Set<BacklogItemStatus>([
  'done',
  'needs_review',
  'rejected',
]);

export type AgentBacklogTransition = {
  action: string;
  status?: BacklogItemStatus;
};

/**
 * Backlog terminal states are outcomes of the technical gate, Judge, or
 * watchdog. Model-facing tools may prepare and execute work, but they may not
 * manufacture a terminal outcome or use needs_review as a completion fallback.
 */
export function assertAgentBacklogTransitionAllowed(
  transition: AgentBacklogTransition,
): void {
  const terminalAction =
    transition.action === 'complete' ||
    transition.action === 'mark_needs_review';
  const terminalStatus =
    transition.action === 'set_status' &&
    transition.status !== undefined &&
    RUNNER_OWNED_STATUSES.has(transition.status);

  if (!terminalAction && !terminalStatus) return;

  throw new Error(
    'Backlog terminal transitions are runner-owned. Do not call complete, ' +
      'mark_needs_review, or set_status with done/rejected/needs_review. ' +
      'Finish the current requirement plan step with ' +
      'instance_plan action="execute_step"; the gate, Judge, or watchdog ' +
      'will apply the resulting backlog status.',
  );
}
