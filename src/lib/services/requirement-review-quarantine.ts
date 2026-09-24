import type {
  BacklogItem,
  BacklogItemStatus,
  BacklogReviewQuarantine,
} from './requirement-backlog-types';
import { requestPlanCancellation } from './requirement-plan-cancellation';

function quarantineKind(
  reason: string,
): BacklogReviewQuarantine['kind'] {
  const normalized = reason.toLowerCase();
  if (normalized.includes('capability')) return 'capability_gap';
  if (
    normalized.includes('stale') ||
    normalized.includes('[watchdog]') ||
    normalized.includes('idle=')
  ) {
    return 'stale';
  }
  if (normalized.includes('manual')) return 'manual';
  return 'verification_exhausted';
}

export function applyBacklogStatusLifecycle(params: {
  item: BacklogItem;
  status: BacklogItemStatus;
  reason?: string;
  externalActionRevision: number;
  now: string;
}): BacklogItem {
  const reopening =
    (params.item.status === 'done' ||
      params.item.status === 'needs_review') &&
    params.status === 'pending';
  let item: BacklogItem = {
    ...params.item,
    status: params.status,
    ...(params.status === 'done' ? { blocked_by: undefined } : {}),
    ...(reopening ? { evidence: undefined } : {}),
    updated_at: params.now,
  };

  if (params.reason && params.status !== 'done') {
    item.assumptions = [
      ...(item.assumptions || []),
      params.reason,
    ].slice(-20);
  }

  if (
    params.status === 'needs_review' &&
    params.item.status !== 'needs_review'
  ) {
    item.review_quarantine = {
      active: true,
      kind: quarantineKind(params.reason || ''),
      reason: params.reason || 'Manual review required',
      quarantined_at: params.now,
      external_action_revision: params.externalActionRevision,
    };
  }

  if (params.status === 'needs_review' || params.status === 'rejected') {
    item = requestPlanCancellation(
      item,
      `setItemStatus → ${params.status}: ${params.reason ?? 'no reason provided'}`.slice(
        0,
        240,
      ),
      params.now,
    );
  }

  return item;
}
