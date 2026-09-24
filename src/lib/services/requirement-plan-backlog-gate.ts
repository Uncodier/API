import type { BacklogItem } from './requirement-backlog-types';

export type PlanBacklogGate =
  | { runnable: true; itemId: string }
  | {
      runnable: false;
      itemId?: string;
      reason:
        | 'unlinked_backlog_item'
        | 'backlog_item_missing'
        | 'backlog_item_not_active'
        | 'backlog_item_blocked'
        | 'backlog_item_quarantined';
    };

export function planStepBacklogItemId(
  step: Record<string, any> | null | undefined,
): string | undefined {
  const value =
    step?.metadata?.backlog_item_id ||
    step?.backlog_item_id;
  return typeof value === 'string' && value ? value : undefined;
}

export function evaluatePlanBacklogGate(
  step: Record<string, any> | null | undefined,
  items: BacklogItem[],
): PlanBacklogGate {
  const itemId = planStepBacklogItemId(step);
  if (!itemId) {
    return { runnable: false, reason: 'unlinked_backlog_item' };
  }
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return { runnable: false, reason: 'backlog_item_missing', itemId };
  }
  if (
    item.status === 'needs_review' ||
    item.review_quarantine?.active === true ||
    item.plan_cancellation_pending
  ) {
    return { runnable: false, reason: 'backlog_item_quarantined', itemId };
  }
  if (item.blocked_by?.length) {
    return { runnable: false, reason: 'backlog_item_blocked', itemId };
  }
  if (item.status !== 'in_progress') {
    return { runnable: false, reason: 'backlog_item_not_active', itemId };
  }
  return { runnable: true, itemId };
}
