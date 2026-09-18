import {
  patchPlanStepAtomically,
  type PlanStepPatchMutation,
} from '@/lib/services/instance-plan-infrastructure-state';
import { NO_PROGRESS_ADJUDICATION_METADATA_KEY } from './no-progress-adjudication';

type BacklogResolver = (instanceId: string) => Promise<{
  requirementId: string | null;
  inProgressItemId: string | null;
}>;

export async function resolveSingleTurnBacklogItemId(params: {
  instanceId: string;
  requirementId: string;
  persistedStep: any;
  step: any;
  resolver?: BacklogResolver;
}): Promise<string | null> {
  const existing =
    params.persistedStep.metadata?.backlog_item_id ||
    params.persistedStep.backlog_item_id ||
    params.step.metadata?.backlog_item_id ||
    params.step.backlog_item_id ||
    null;
  if (existing) return existing;

  try {
    const resolver =
      params.resolver ||
      (await import('@/lib/services/requirement-backlog'))
        .resolveBacklogContextForInstance;
    const context = await resolver(params.instanceId);
    if (context.requirementId !== params.requirementId) {
      console.warn(
        `[SingleTurn] Ignoring backlog binding from requirement ${context.requirementId || 'unknown'}; expected ${params.requirementId}`,
      );
      return null;
    }
    return context.inProgressItemId;
  } catch (error: unknown) {
    console.warn(
      '[SingleTurn] Could not resolve backlog binding:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export function buildSingleTurnStartMetadata(params: {
  persistedMetadata?: Record<string, unknown>;
  interactionBaselineSha?: string;
  backlogItemId?: string | null;
}): Record<string, unknown> | undefined {
  if (!params.interactionBaselineSha && !params.backlogItemId) return undefined;
  return {
    ...(params.persistedMetadata || {}),
    ...(params.interactionBaselineSha
      ? { interaction_audit_baseline_sha: params.interactionBaselineSha }
      : {}),
    ...(params.backlogItemId
      ? { backlog_item_id: params.backlogItemId }
      : {}),
  };
}

export async function markVisualFeedbackDelivered(params: {
  planId: string;
  instanceId: string;
  siteId: string;
  requirementId: string;
  stepId: string;
  persistedMetadata?: Record<string, unknown>;
  interactionBaselineSha?: string;
  backlogItemId?: string | null;
  imageFeedbackId?: string;
  delivered: boolean;
  expectedGeneration: number;
  eventId: string;
}): Promise<PlanStepPatchMutation | undefined> {
  if (!params.delivered || !params.imageFeedbackId) return;
  return patchPlanStepAtomically({
    planId: params.planId,
    stepId: params.stepId,
    expectedGeneration: params.expectedGeneration,
    eventId: params.eventId,
    patch: {
      metadata: {
        ...(params.persistedMetadata || {}),
        ...(params.interactionBaselineSha
          ? { interaction_audit_baseline_sha: params.interactionBaselineSha }
          : {}),
        ...(params.backlogItemId
          ? { backlog_item_id: params.backlogItemId }
          : {}),
        visual_feedback_image_id: params.imageFeedbackId,
      },
    },
  });
}

export async function markNoProgressAdjudicationConsumed(params: {
  planId: string;
  stepId: string;
  expectedGeneration: number;
  eventId: string;
  persistedMetadata?: Record<string, unknown>;
}): Promise<PlanStepPatchMutation> {
  return patchPlanStepAtomically({
    planId: params.planId,
    stepId: params.stepId,
    expectedGeneration: params.expectedGeneration,
    eventId: params.eventId,
    patch: {
      metadata: {
        ...(params.persistedMetadata || {}),
        [NO_PROGRESS_ADJUDICATION_METADATA_KEY]: {
          ...(
            (
              params.persistedMetadata?.[
                NO_PROGRESS_ADJUDICATION_METADATA_KEY
              ]
            ) as Record<string, unknown> | undefined
          ),
          state: 'consumed',
          consumed_at: new Date().toISOString(),
        },
      },
    },
  });
}
