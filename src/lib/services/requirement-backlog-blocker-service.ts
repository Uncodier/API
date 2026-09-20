import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';
import {
  addDirectBacklogBlocker,
  directBacklogBlockers,
  isBacklogItemRunnable,
  reconcileBacklogBlockedBy,
  removeDirectBacklogBlocker,
} from './requirement-backlog-blockers';
import { assertBacklogInvariants } from './requirement-backlog-invariants';
import { mutateBacklogAtomically } from './requirement-backlog-mutation';
import { computeRatio } from './requirement-backlog-store';
import type {
  BacklogBlocker,
  BacklogBlockerCategory,
  BacklogBlockerResolutionActor,
  BacklogItem,
} from './requirement-backlog-types';

export interface BlockBacklogItemInput {
  requirementId: string;
  itemId: string;
  blockerId?: string;
  category: BacklogBlockerCategory;
  reason: string;
  resolutionActor: BacklogBlockerResolutionActor;
  sourceStepId?: string;
  userActionRequired?: boolean;
  retryAfter?: string;
  /** Leave state unchanged unless another backlog item can run immediately. */
  requireRunnableAlternative?: boolean;
  attemptLimits?: { core: number; ornamental: number };
}

export interface BlockBacklogItemResult {
  item: BacklogItem;
  blocker: BacklogBlocker;
  affectedItemIds: string[];
}

function defaultBlockerId(input: BlockBacklogItemInput): string {
  const source = input.sourceStepId || input.itemId;
  return `${input.category}:${source}`;
}

export async function blockBacklogItem(
  input: BlockBacklogItemInput,
): Promise<BlockBacklogItemResult | null> {
  const createdAt = new Date().toISOString();
  const blocker: BacklogBlocker = {
    blocker_id: input.blockerId || defaultBlockerId(input),
    category: input.category,
    reason: input.reason.trim(),
    resolution_actor: input.resolutionActor,
    source_item_id: input.itemId,
    source_step_id: input.sourceStepId,
    user_action_required:
      input.userActionRequired === true || input.resolutionActor === 'user',
    retry_after: input.retryAfter,
    created_at: createdAt,
  };

  const result = await mutateBacklogAtomically(
    input.requirementId,
    ({ backlog, flow }) => {
      const index = backlog.items.findIndex((item) => item.id === input.itemId);
      if (index < 0) throw new Error(`Item ${input.itemId} not found`);
      if (backlog.items[index].status === 'done') {
        throw new Error(`Cannot block completed backlog item ${input.itemId}`);
      }

      const item = {
        ...backlog.items[index],
        status: 'pending' as const,
        updated_at: createdAt,
      };
      addDirectBacklogBlocker(item, blocker);
      backlog.items[index] = item;
      reconcileBacklogBlockedBy(backlog.items);
      if (input.requireRunnableAlternative) {
        const completedIds = new Set(
          backlog.items
            .filter((candidate) => candidate.status === 'done')
            .map((candidate) => candidate.id),
        );
        const hasAlternative = backlog.items.some(
          (candidate) =>
            candidate.id !== input.itemId &&
            isBacklogItemRunnable(
              candidate,
              completedIds,
              input.attemptLimits,
            ),
        );
        if (!hasAlternative) {
          return { result: null, write: false };
        }
      }
      assertBacklogInvariants(
        backlog.items,
        flow.phases.map((phase) => phase.id),
      );
      backlog.completion_ratio = computeRatio(backlog.items);
      return {
        result: {
          item: backlog.items[index],
          blocker,
          affectedItemIds: backlog.items
            .filter((candidate) =>
              candidate.blocked_by?.some(
                (candidateBlocker) =>
                  candidateBlocker.blocker_id === blocker.blocker_id,
              ),
            )
            .map((candidate) => candidate.id),
        },
      };
    },
  );

  if (!result) return null;
  const cancellation = await cancelPlanStepsForBacklogItem({
    requirementId: input.requirementId,
    itemId: input.itemId,
    affectedItemIds: result.affectedItemIds,
    reason:
      `Blocked by ${blocker.blocker_id}: ${blocker.reason}`.slice(0, 240),
  });
  if (cancellation.errors.length > 0) {
    throw new Error(
      `Blocker ${blocker.blocker_id} persisted, but plan cancellation failed: ` +
      cancellation.errors.join('; '),
    );
  }
  return result;
}

export async function resolveBacklogItemBlocker(params: {
  requirementId: string;
  itemId: string;
  blockerId: string;
  reason?: string;
}): Promise<BacklogItem> {
  return mutateBacklogAtomically(
    params.requirementId,
    ({ backlog, flow }) => {
      const index = backlog.items.findIndex((item) => item.id === params.itemId);
      if (index < 0) throw new Error(`Item ${params.itemId} not found`);
      const item = { ...backlog.items[index] };
      if (
        !directBacklogBlockers(item).some(
          (blocker) => blocker.blocker_id === params.blockerId,
        )
      ) {
        throw new Error(
          `Direct blocker ${params.blockerId} was not found on item ${params.itemId}`,
        );
      }
      removeDirectBacklogBlocker(item, params.blockerId);
      if (params.reason) {
        item.assumptions = [
          ...(item.assumptions || []),
          `[blocker-resolved:${params.blockerId}] ${params.reason}`,
        ].slice(-20);
      }
      item.updated_at = new Date().toISOString();
      backlog.items[index] = item;
      reconcileBacklogBlockedBy(backlog.items);
      assertBacklogInvariants(
        backlog.items,
        flow.phases.map((phase) => phase.id),
      );
      return { result: backlog.items[index] };
    },
  );
}
