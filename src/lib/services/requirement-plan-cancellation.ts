import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';
import type { BacklogItem } from './requirement-backlog-types';
import { mutateBacklogAtomically } from './requirement-backlog-mutation';

export interface PendingPlanCancellation {
  itemId: string;
  reason: string;
  requestedAt: string;
}

export function requestPlanCancellation(
  item: BacklogItem,
  reason: string,
  requestedAt: string,
): BacklogItem {
  return {
    ...item,
    plan_cancellation_pending: {
      reason,
      requested_at: requestedAt,
    },
  };
}

export function pendingPlanCancellation(
  item: BacklogItem,
): PendingPlanCancellation | null {
  const request = item.plan_cancellation_pending;
  if (!request || !request.reason) return null;
  return {
    itemId: item.id,
    reason: request.reason,
    requestedAt: request.requested_at,
  };
}

export async function fulfillPlanCancellationRequests(params: {
  requirementId: string;
  requests: PendingPlanCancellation[];
  instanceId?: string;
}): Promise<void> {
  const requests = Array.from(
    new Map(params.requests.map((request) => [request.itemId, request])).values(),
  );
  if (requests.length === 0) return;

  for (const request of requests) {
    const cancellation = await cancelPlanStepsForBacklogItem({
      requirementId: params.requirementId,
      itemId: request.itemId,
      reason: request.reason,
      instanceId: params.instanceId,
    });
    if (cancellation.errors.length > 0) {
      throw new Error(
        `Failed to cancel plans for backlog item ${request.itemId}: ` +
        cancellation.errors.join('; '),
      );
    }
  }

  const fulfilledByItemId = new Map(
    requests.map((request) => [request.itemId, request]),
  );
  await mutateBacklogAtomically(
    params.requirementId,
    ({ backlog }) => {
      let changed = false;
      for (let index = 0; index < backlog.items.length; index++) {
        const item = backlog.items[index];
        const fulfilled = fulfilledByItemId.get(item.id);
        if (
          !fulfilled ||
          !item.plan_cancellation_pending ||
          item.plan_cancellation_pending.requested_at !== fulfilled.requestedAt
        ) {
          continue;
        }
        const nextItem = { ...item };
        delete nextItem.plan_cancellation_pending;
        backlog.items[index] = nextItem;
        changed = true;
      }
      return { result: undefined, write: changed };
    },
    { onMissing: () => undefined },
  );
}
