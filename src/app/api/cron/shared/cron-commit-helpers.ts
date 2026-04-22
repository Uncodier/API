/**
 * Facade — keeps the historical import path intact while the implementation
 * is split into focused modules under `./commit/*`. Do not add new logic here;
 * extend the sub-modules instead.
 *
 * See the individual modules for details:
 * - ./commit/status-sync.ts      — requirement_status sync + patch + site/binding resolution.
 * - ./commit/commit-workspace.ts — commit/push loop (includes ground-truth mirror).
 * - ./commit/checkpoint.ts       — post-step checkpoint wrapper.
 */

export {
  type GitRepoKind,
  repoNameForGitRepoKind,
  resolveGitBindingForRequirement,
  resolveSiteIdForRequirementStatus,
  syncLatestRequirementStatusWithPreview,
  patchLatestRequirementStatusColumns,
} from './commit/status-sync';

export {
  commitWorkspaceToOrigin,
  classifyGitPushFailure,
} from './commit/commit-workspace';

export {
  type PlanStepCheckpointKind,
  checkpointPlanIteration,
} from './commit/checkpoint';
