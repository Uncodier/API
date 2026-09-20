import type {
  BacklogItem,
  BacklogItemStatus,
} from './requirement-backlog-types';
import { isBacklogItemBlocked } from './requirement-backlog-blockers';

const ACTIVE_STATUSES = new Set<BacklogItemStatus>([
  'in_progress',
  'critic_review',
  'judge_review',
]);

export function isBacklogActiveStatus(
  status: BacklogItemStatus,
): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function assertBacklogGraph(
  items: BacklogItem[],
  phaseOrder: string[] = [],
): void {
  const itemsById = new Map<string, BacklogItem>();
  const phaseIndexes = new Map(
    phaseOrder.map((phaseId, index) => [phaseId, index]),
  );

  for (const item of items) {
    if (itemsById.has(item.id)) {
      throw new Error(
        `Backlog invariant violation: duplicate item id "${item.id}"`,
      );
    }
    itemsById.set(item.id, item);
  }

  for (const item of items) {
    for (const dependencyId of item.depends_on || []) {
      if (dependencyId === item.id) {
        throw new Error(
          `Backlog invariant violation: item "${item.id}" cannot depend on itself`,
        );
      }
      if (!itemsById.has(dependencyId)) {
        throw new Error(
          `Backlog invariant violation: item "${item.id}" depends on unknown item "${dependencyId}"`,
        );
      }
      const itemPhaseIndex = phaseIndexes.get(item.phase_id);
      const dependencyPhaseIndex = phaseIndexes.get(
        itemsById.get(dependencyId)?.phase_id || '',
      );
      if (
        itemPhaseIndex !== undefined &&
        dependencyPhaseIndex !== undefined &&
        dependencyPhaseIndex > itemPhaseIndex
      ) {
        throw new Error(
          `Backlog invariant violation: item "${item.id}" cannot depend on later-phase item "${dependencyId}"`,
        );
      }
    }
  }

  const visitState = new Map<string, 'visiting' | 'visited'>();
  const path: string[] = [];

  const visit = (itemId: string): void => {
    visitState.set(itemId, 'visiting');
    path.push(itemId);

    for (const dependencyId of itemsById.get(itemId)?.depends_on || []) {
      const state = visitState.get(dependencyId);
      if (state === 'visiting') {
        const cycleStart = path.indexOf(dependencyId);
        const cycle = [...path.slice(cycleStart), dependencyId];
        throw new Error(
          `Backlog dependency cycle detected: ${cycle.join(' -> ')}`,
        );
      }
      if (state !== 'visited') visit(dependencyId);
    }

    path.pop();
    visitState.set(itemId, 'visited');
  };

  for (const item of items) {
    if (!visitState.has(item.id)) visit(item.id);
  }
}

export function assertBacklogTransitionInvariants(
  items: BacklogItem[],
): void {
  const activeItems = items.filter((item) =>
    isBacklogActiveStatus(item.status),
  );
  if (activeItems.length > 1) {
    const activeSummary = activeItems
      .map((item) => `${item.id} (${item.status})`)
      .join(', ');
    throw new Error(
      `WIP=1 violation: multiple active backlog items: ${activeSummary}`,
    );
  }

  const itemsById = new Map(items.map((item) => [item.id, item]));
  for (const item of activeItems) {
    if (isBacklogItemBlocked(item)) {
      throw new Error(
        `Cannot keep backlog item "${item.id}" active: blocked_by is not empty`,
      );
    }
    const blockedBy = (item.depends_on || [])
      .map((dependencyId) => itemsById.get(dependencyId))
      .filter(
        (dependency): dependency is BacklogItem =>
          !!dependency && dependency.status !== 'done',
      );
    if (blockedBy.length > 0) {
      const dependencySummary = blockedBy
        .map((dependency) => `${dependency.id} (${dependency.status})`)
        .join(', ');
      throw new Error(
        `Cannot move backlog item "${item.id}" to ${item.status}: dependencies are not done: ${dependencySummary}`,
      );
    }
  }
}

export function assertBacklogStatusTransition(
  items: BacklogItem[],
  itemId: string,
  nextStatus: BacklogItemStatus,
  options: { allowDoneReopen?: boolean } = {},
): void {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(`Backlog item "${itemId}" not found`);
  }

  const currentStatus = item.status;
  if (currentStatus === 'done' && nextStatus !== 'done') {
    if (!(options.allowDoneReopen && nextStatus === 'pending')) {
      throw new Error(
        `Cannot transition completed backlog item "${itemId}" from done to ${nextStatus}; explicitly reopen it to pending first`,
      );
    }
  }

  const allowedSources: Partial<
    Record<BacklogItemStatus, BacklogItemStatus[]>
  > = {
    in_progress: ['pending', 'in_progress'],
    critic_review: ['in_progress', 'critic_review'],
    judge_review: ['in_progress', 'critic_review', 'judge_review'],
    done: ['in_progress', 'critic_review', 'judge_review', 'done'],
  };
  const sources = allowedSources[nextStatus];
  if (sources && !sources.includes(currentStatus)) {
    throw new Error(
      `Cannot transition backlog item "${itemId}" from ${currentStatus} to ${nextStatus}`,
    );
  }

  if (
    nextStatus === 'in_progress' ||
    nextStatus === 'critic_review' ||
    nextStatus === 'judge_review' ||
    nextStatus === 'done'
  ) {
    if (isBacklogItemBlocked(item)) {
      throw new Error(
        `Cannot move backlog item "${itemId}" to ${nextStatus}: blocked_by is not empty`,
      );
    }
    const itemsById = new Map(items.map((candidate) => [candidate.id, candidate]));
    const blockedBy = (item.depends_on || [])
      .map((dependencyId) => itemsById.get(dependencyId))
      .filter(
        (dependency): dependency is BacklogItem =>
          !!dependency && dependency.status !== 'done',
      );
    if (blockedBy.length > 0) {
      const dependencySummary = blockedBy
        .map((dependency) => `${dependency.id} (${dependency.status})`)
        .join(', ');
      throw new Error(
        `Cannot move backlog item "${itemId}" to ${nextStatus}: dependencies are not done: ${dependencySummary}`,
      );
    }
  }
}

export function assertBacklogInvariants(
  items: BacklogItem[],
  phaseOrder: string[] = [],
): void {
  assertBacklogGraph(items, phaseOrder);
  assertBacklogTransitionInvariants(items);
}
