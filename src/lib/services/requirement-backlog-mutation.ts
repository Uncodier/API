import {
  classifyRequirementType,
  getFlow,
  type FlowDefinition,
} from './requirement-flows';
import type { RequirementBacklog } from './requirement-backlog-types';
import {
  BacklogWriteConflictError,
  loadRequirement,
  toBacklog,
  writeBacklogCas,
  type RequirementRow,
} from './requirement-backlog-store';

const MAX_BACKLOG_WRITE_ATTEMPTS = 4;

export type BacklogMutationContext = {
  requirement: RequirementRow;
  backlog: RequirementBacklog;
  flow: FlowDefinition;
};

export type BacklogMutationResult<T> = {
  result: T;
  backlog?: RequirementBacklog;
  write?: boolean;
};

/**
 * Replays a pure backlog transformation when another writer wins the
 * optimistic-concurrency race. External side effects must happen only after
 * this function resolves because the mutation callback may run more than once.
 */
export async function mutateBacklogAtomically<T>(
  requirementId: string,
  mutate: (
    context: BacklogMutationContext,
  ) => BacklogMutationResult<T> | Promise<BacklogMutationResult<T>>,
  options: { onMissing?: () => T } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_BACKLOG_WRITE_ATTEMPTS; attempt++) {
    const requirement = await loadRequirement(requirementId);
    if (!requirement) {
      if (options.onMissing) return options.onMissing();
      throw new Error(`Requirement ${requirementId} not found`);
    }
    const flow = getFlow(classifyRequirementType(requirement.type));
    const backlog = toBacklog(
      requirement.backlog,
      flow.phases[0]?.id || 'default',
    );
    const outcome = await mutate({ requirement, backlog, flow });
    if (outcome.write === false) return outcome.result;

    try {
      await writeBacklogCas(
        requirementId,
        outcome.backlog || backlog,
        Number(requirement.backlog_revision) || 0,
      );
      return outcome.result;
    } catch (error) {
      if (
        !(error instanceof BacklogWriteConflictError) ||
        attempt === MAX_BACKLOG_WRITE_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new BacklogWriteConflictError(requirementId);
}
