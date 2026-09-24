import type {
  BacklogBlocker,
  BacklogItem,
} from './requirement-backlog-types';

function isBlocker(value: unknown): value is BacklogBlocker {
  if (!value || typeof value !== 'object') return false;
  const blocker = value as Partial<BacklogBlocker>;
  return (
    typeof blocker.blocker_id === 'string' &&
    blocker.blocker_id.length > 0 &&
    typeof blocker.category === 'string' &&
    typeof blocker.reason === 'string' &&
    typeof blocker.resolution_actor === 'string'
  );
}

export function directBacklogBlockers(item: BacklogItem): BacklogBlocker[] {
  return (Array.isArray(item.blocked_by) ? item.blocked_by : [])
    .filter(isBlocker)
    .filter((blocker) => !blocker.propagated_from_item_id);
}

function dependencyBlocker(dependency: BacklogItem): BacklogBlocker {
  const legacyReviewBlocker = dependency.status === 'needs_review';
  return {
    blocker_id: `dependency:${dependency.id}`,
    category: 'dependency',
    reason:
      `Depends on unfinished item "${dependency.title}" ` +
      `(status=${dependency.status}).`,
    resolution_actor: legacyReviewBlocker ? 'user' : 'executor',
    source_item_id: dependency.id,
    propagated_from_item_id: dependency.id,
    user_action_required: legacyReviewBlocker,
  };
}

/**
 * Materializes transitive blocker information on every item.
 *
 * `depends_on` remains the canonical DAG. `blocked_by` is the operational,
 * UI-friendly view and is rebuilt from direct blockers plus unfinished
 * dependencies whenever the backlog is loaded or mutated.
 */
export function reconcileBacklogBlockedBy(items: BacklogItem[]): BacklogItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const directById = new Map(
    items.map((item) => [item.id, directBacklogBlockers(item)]),
  );
  const memo = new Map<string, BacklogBlocker[]>();
  const visiting = new Set<string>();

  const resolve = (item: BacklogItem): BacklogBlocker[] => {
    const cached = memo.get(item.id);
    if (cached) return cached;
    if (visiting.has(item.id)) return directById.get(item.id) || [];
    visiting.add(item.id);

    const blockers = [...(directById.get(item.id) || [])];
    for (const dependencyId of item.depends_on || []) {
      const dependency = byId.get(dependencyId);
      if (!dependency || dependency.status === 'done') continue;
      const dependencyBlockers = resolve(dependency);
      if (dependencyBlockers.length === 0) {
        blockers.push(dependencyBlocker(dependency));
        continue;
      }
      blockers.push(
        ...dependencyBlockers.map((blocker) => ({
          ...blocker,
          propagated_from_item_id: dependency.id,
        })),
      );
    }

    visiting.delete(item.id);
    const deduped = Array.from(
      new Map(
        blockers.map((blocker) => [blocker.blocker_id, blocker]),
      ).values(),
    );
    memo.set(item.id, deduped);
    return deduped;
  };

  for (const item of items) {
    const blockers = resolve(item);
    item.blocked_by = blockers.length > 0 ? blockers : undefined;
  }
  return items;
}

export function isBacklogItemBlocked(
  item: Pick<BacklogItem, 'blocked_by'>,
): boolean {
  return Array.isArray(item.blocked_by) && item.blocked_by.length > 0;
}

export function isBacklogItemRunnable(
  item: Pick<
    BacklogItem,
    | 'status'
    | 'attempts'
    | 'tier'
    | 'depends_on'
    | 'blocked_by'
    | 'review_quarantine'
  >,
  completedIds: ReadonlySet<string>,
  limits?: { core: number; ornamental: number },
): boolean {
  if (item.status !== 'pending' && item.status !== 'in_progress') return false;
  if (item.review_quarantine?.active === true) return false;
  if (isBacklogItemBlocked(item)) return false;
  if (
    limits &&
    (item.attempts || 0) >= (
      (item.tier ?? 'core') === 'ornamental'
        ? limits.ornamental
        : limits.core
    )
  ) {
    return false;
  }
  return (item.depends_on || []).every((dependencyId) =>
    completedIds.has(dependencyId),
  );
}

export function requiresUserAction(
  item: Pick<BacklogItem, 'blocked_by'>,
): boolean {
  return (item.blocked_by || []).some(
    (blocker) =>
      blocker.user_action_required === true ||
      blocker.resolution_actor === 'user',
  );
}

export function addDirectBacklogBlocker(
  item: BacklogItem,
  blocker: BacklogBlocker,
): void {
  const direct = directBacklogBlockers(item).filter(
    (candidate) => candidate.blocker_id !== blocker.blocker_id,
  );
  item.blocked_by = [...direct, {
    ...blocker,
    source_item_id: blocker.source_item_id || item.id,
    propagated_from_item_id: undefined,
  }];
}

export function removeDirectBacklogBlocker(
  item: BacklogItem,
  blockerId: string,
): void {
  const remaining = directBacklogBlockers(item).filter(
    (blocker) => blocker.blocker_id !== blockerId,
  );
  item.blocked_by = remaining.length > 0 ? remaining : undefined;
}

export function releaseDueAutomaticBlockers(
  items: BacklogItem[],
  nowMs: number = Date.now(),
): string[] {
  const released: string[] = [];
  for (const item of items) {
    const direct = directBacklogBlockers(item);
    const remaining = direct.filter((blocker) => {
      if (
        blocker.resolution_actor === 'user' ||
        typeof blocker.retry_after !== 'string'
      ) {
        return true;
      }
      const retryAt = Date.parse(blocker.retry_after);
      if (!Number.isFinite(retryAt) || retryAt > nowMs) return true;
      released.push(blocker.blocker_id);
      item.assumptions = [
        ...(item.assumptions || []),
        `[blocker-retry:${blocker.blocker_id}] Automatic retry window opened.`,
      ].slice(-20);
      item.updated_at = new Date(nowMs).toISOString();
      return false;
    });
    item.blocked_by = remaining.length > 0 ? remaining : undefined;
  }
  if (released.length > 0) reconcileBacklogBlockedBy(items);
  return released;
}
