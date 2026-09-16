import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import {
  buildSingleTurnStartMetadata,
  markVisualFeedbackDelivered,
  resolveSingleTurnBacklogItemId,
} from '../single-turn-step-state';

jest.mock('@/app/api/agents/tools/instance_plan/update/route', () => ({
  updateInstancePlanCore: jest.fn(),
}));

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
    });
    expect(updateInstancePlanCore).not.toHaveBeenCalled();

    await markVisualFeedbackDelivered({
      planId: 'plan-1',
      instanceId: 'instance-1',
      siteId: 'site-1',
      requirementId: 'requirement-1',
      stepId: 'step-1',
      backlogItemId: 'backlog-1',
      imageFeedbackId: 'image-1',
      delivered: true,
    });
    expect(updateInstancePlanCore).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            metadata: expect.objectContaining({
              backlog_item_id: 'backlog-1',
              visual_feedback_image_id: 'image-1',
            }),
          }),
        ],
      }),
    );
  });
});
