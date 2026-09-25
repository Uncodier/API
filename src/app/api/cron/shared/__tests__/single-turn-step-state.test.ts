import { patchPlanStepAtomically } from '@/lib/services/instance-plan-infrastructure-state';
import {
  buildSingleTurnStartMetadata,
  markNoProgressAdjudicationConsumed,
  markNoProgressAdjudicationRetryable,
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
      cycleId: 'cycle-1',
      executionGeneration: 3,
    });

    expect(resolver).toHaveBeenCalledWith('instance-1');
    expect(metadata).toMatchObject({
      backlog_item_id: 'backlog-1',
      interaction_audit_baseline_sha: 'a'.repeat(40),
      cron_cycle_id: 'cycle-1',
      cron_execution_generation: 3,
    });
  });

  it('replaces stale cycle identity even without optional start metadata', () => {
    expect(buildSingleTurnStartMetadata({
      persistedMetadata: {
        cron_cycle_id: 'cycle-1',
        cron_execution_generation: 2,
      },
      cycleId: 'cycle-2',
      executionGeneration: 3,
    })).toMatchObject({
      cron_cycle_id: 'cycle-2',
      cron_execution_generation: 3,
    });
  });

  it('marks a persisted repair run in progress when its executor turn starts', () => {
    expect(buildSingleTurnStartMetadata({
      persistedMetadata: {
        repair_run: {
          schema_version: 1,
          diagnostic_id: 'diagnostic-1',
          repair_run_id: 'repair-1',
          status: 'planned',
          failure_kind: 'evidence_gap',
          contract_revision: 'contract-1',
          created_at: '2026-09-25T00:00:00.000Z',
          max_attempts: 3,
          actions: [],
        },
      },
      cycleId: 'cycle-2',
      executionGeneration: 3,
    })).toMatchObject({
      repair_run: {
        repair_run_id: 'repair-1',
        status: 'in_progress',
      },
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

  it('returns a failed adjudication to a retryable state', async () => {
    mockPatchPlanStep.mockResolvedValue({
      state: 'applied',
      persisted: true,
      generation: 9,
    });

    await markNoProgressAdjudicationRetryable({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 8,
      eventId: 'cycle-4:no-progress-retryable',
      persistedMetadata: {
        no_progress_adjudication: {
          state: 'requested',
          execution_generation: 5,
        },
      },
    });

    expect(mockPatchPlanStep).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 8,
        patch: {
          metadata: expect.objectContaining({
            no_progress_adjudication: expect.objectContaining({
              state: 'retryable',
              execution_generation: 5,
            }),
          }),
        },
      }),
    );
  });
});
