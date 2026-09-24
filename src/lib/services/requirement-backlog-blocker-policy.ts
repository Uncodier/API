import type {
  BacklogBlocker,
  BacklogItem,
} from './requirement-backlog-types';

export type BacklogBlockerResolver =
  | 'agent'
  | 'runner'
  | 'platform'
  | 'user';

export function assertBacklogItemCanBeBlocked(
  item: Pick<BacklogItem, 'id' | 'status' | 'review_quarantine'>,
): void {
  if (
    item.status === 'done' ||
    item.status === 'rejected' ||
    item.status === 'needs_review' ||
    item.review_quarantine?.active === true
  ) {
    throw new Error(
      `Cannot block terminal or quarantined backlog item ${item.id}`,
    );
  }
}

export function assertBacklogBlockerCanBeResolved(
  blocker: BacklogBlocker,
  resolver: BacklogBlockerResolver,
): void {
  if (
    blocker.resolution_actor === 'user' &&
    resolver !== 'user'
  ) {
    throw new Error(
      `Blocker ${blocker.blocker_id} requires an external user action`,
    );
  }
  if (
    blocker.resolution_actor === 'platform' &&
    resolver !== 'platform'
  ) {
    throw new Error(
      `Blocker ${blocker.blocker_id} is platform-owned`,
    );
  }
}
