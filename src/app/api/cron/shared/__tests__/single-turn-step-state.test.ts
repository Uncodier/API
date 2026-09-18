import { patchPlanStepAtomically } from '@/lib/services/instance-plan-infrastructure-state';
import {
  buildSingleTurnStartMetadata,
  markNoProgressAdjudicationConsumed,
  markVisualFeedbackDelivered,
  resolveSingleTurnBacklogItemId,
} from '../single-turn-step-state';

jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  patchPlanStepAtomically: jest.fn(),
}));

const mockPatchPlanStep =
  patchPlanStepAtomically as jest.MockedFunction<typeof patchPlanStepAtomically>;

describe('single-turn step state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves and persists a missing backlog binding before the first gate', async () => {
    const resolver = jest.fn().mockResolvedValue({
      requirementId: 'requirement-1',
      inProgressItemId: 'backlog-1',
    });

    const backlogItemId = await resolveSingleTurnBacklogItemId({
      instanceId: 'instance-1',
      requirementId: 'requirement-1',
      persistedStep: {},
      step: {},
      resolver,
    });
    const metadata = buildSingleTurnStartMetadata({
      persistedMetadata: {},
      interactionBaselineSha: 'a'.repeat(40),
      backlogItemId,
    });

    expect(resolver).toHaveBeenCalledWith('instance-1');
    expect(metadata).toMatchObject({
      backlog_item_id: 'backlog-1',
      interaction_audit_baseline_sha: 'a'.repeat(40),
    });
  });

  it('rejects a fallback binding from another requirement', async () => {
    const backlogItemId = await resolveSingleTurnBacklogItemId({
      instanceId: 'instance-1',
      requirementId: 'requirement-1',
      persistedStep: {},
      step: {},
      resolver: jest.fn().mockResolvedValue({
        requirementId: 'requirement-2',
        inProgressItemId: 'backlog-2',
      }),
    });

    expect(backlogItemId).toBeNull();
  });

  it('marks an image delivered only after a multimodal message was sent', async () => {
    await markVisualFeedbackDelivered({
      planId: 'plan-1',
      instanceId: 'instance-1',
      siteId: 'site-1',
      requirementId: 'requirement-1',
      stepId: 'step-1',
      backlogItemId: 'backlog-1',
      imageFeedbackId: 'image-1',
      delivered: false,
      expectedGeneration: 3,
      eventId: 'cycle-1:visual-feedback',
    });
    expect(mockPatchPlanStep).not.toHaveBeenCalled();

    mockPatchPlanStep.mockResolvedValue({
      state: 'applied',
      persisted: true,
      generation: 4,
    });
    await markVisualFeedbackDelivered({
      planId: 'plan-1',
      instanceId: 'instance-1',
      siteId: 'site-1',
      requirementId: 'requirement-1',
      stepId: 'step-1',
      backlogItemId: 'backlog-1',
      imageFeedbackId: 'image-1',
      delivered: true,
      expectedGeneration: 3,
      eventId: 'cycle-1:visual-feedback',
    });
    expect(mockPatchPlanStep).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 3,
        eventId: 'cycle-1:visual-feedback',
        patch: expect.objectContaining({
          metadata: expect.objectContaining({
            backlog_item_id: 'backlog-1',
            visual_feedback_image_id: 'image-1',
          }),
        }),
      }),
    );
  });

  it('atomically consumes a no-progress adjudication request', async () => {
    mockPatchPlanStep.mockResolvedValue({
      state: 'applied',
      persisted: true,
      generation: 8,
    });

    await markNoProgressAdjudicationConsumed({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 7,
      eventId: 'cycle-3:no-progress-consumed',
      persistedMetadata: {
        backlog_item_id: 'backlog-1',
        no_progress_adjudication: {
          state: 'requested',
          cycle_id: 'cycle-2',
          execution_generation: 5,
        },
      },
    });

    expect(mockPatchPlanStep).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 7,
        patch: {
          metadata: expect.objectContaining({
            backlog_item_id: 'backlog-1',
            no_progress_adjudication: expect.objectContaining({
              state: 'consumed',
              cycle_id: 'cycle-2',
              execution_generation: 5,
            }),
          }),
        },
      }),
    );
  });
});
