import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockMutateBacklogAtomically = jest.fn<
  (
    requirementId: string,
    mutate: (context: any) => any,
  ) => Promise<any>
>();
const mockFulfillPlanCancellationRequests = jest.fn<
  (params: any) => Promise<void>
>();

jest.mock('../requirement-backlog-mutation', () => ({
  mutateBacklogAtomically: mockMutateBacklogAtomically,
}));
jest.mock('../requirement-plan-cancellation', () => ({
  pendingPlanCancellation: (item: any) => item.plan_cancellation_pending
    ? {
        itemId: item.id,
        reason: item.plan_cancellation_pending.reason,
        requestedAt: item.plan_cancellation_pending.requested_at,
      }
    : null,
  requestPlanCancellation: (item: any, reason: string, requestedAt: string) => ({
    ...item,
    plan_cancellation_pending: { reason, requested_at: requestedAt },
  }),
  fulfillPlanCancellationRequests: mockFulfillPlanCancellationRequests,
}));
jest.mock('../requirement-flows', () => ({
  advancePhaseIfReadyInMemory: jest.fn(() => null),
  classifyRequirementType: jest.fn(),
  getFlow: jest.fn(),
  productAttemptLimits: jest.fn(() => ({ core: 4, ornamental: 2 })),
}));
jest.mock('../requirement-backlog-store', () => ({
  computeRatio: jest.fn(() => 0),
  loadRequirement: jest.fn(),
  reconcilePhaseForItem: jest.fn(),
  toBacklog: jest.fn(),
}));
jest.mock('../requirement-metadata-patch', () => ({
  patchRequirementMetadataKeys: jest.fn(),
}));

import {
  ensureInProgressItem,
  escalateStaleInProgressItems,
} from '../requirement-backlog-watchdog';

describe('watchdog plan cancellation retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFulfillPlanCancellationRequests.mockResolvedValue(undefined);
  });

  it('retries cancellation after needs_review was already committed', async () => {
    const backlog = {
      items: [{
        id: 'item-1',
        status: 'needs_review',
        plan_cancellation_pending: {
          reason: 'watchdog cancellation',
          requested_at: '2026-09-20T01:00:00.000Z',
        },
      }],
    };
    mockMutateBacklogAtomically.mockImplementation(
      async (_requirementId: string, mutate: any) => (
        await mutate({ backlog, flow: {} })
      ).result,
    );

    await expect(escalateStaleInProgressItems({
      requirementId: 'requirement-1',
    })).resolves.toEqual({ escalated: [] });

    expect(mockFulfillPlanCancellationRequests).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      requests: [{
        itemId: 'item-1',
        reason: 'watchdog cancellation',
        requestedAt: '2026-09-20T01:00:00.000Z',
      }],
    });
  });

  it('records a quarantine watermark before cancelling stale work', async () => {
    const backlog = {
      items: [{
        id: 'item-1',
        status: 'in_progress',
        tier: 'core',
        attempts: 4,
        updated_at: '2026-09-20T01:00:00.000Z',
      }],
    };
    mockMutateBacklogAtomically.mockImplementation(
      async (_requirementId: string, mutate: any) => (
        await mutate({
          requirement: { external_user_action_revision: 5 },
          backlog,
          flow: {},
        })
      ).result,
    );

    const result = await escalateStaleInProgressItems({
      requirementId: 'requirement-1',
      maxIdleMs: 1,
      maxAttempts: 4,
    });

    expect(result.escalated[0]).toEqual(expect.objectContaining({
      status: 'needs_review',
      review_quarantine: expect.objectContaining({
        active: true,
        kind: 'stale',
        external_action_revision: 5,
      }),
      plan_cancellation_pending: expect.any(Object),
    }));
    expect(mockFulfillPlanCancellationRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: 'requirement-1',
        requests: [expect.objectContaining({ itemId: 'item-1' })],
      }),
    );
  });

  it('does not promote exhausted core work', async () => {
    const backlog = {
      current_phase_id: 'build',
      items: [{
        id: 'item-1',
        phase_id: 'build',
        status: 'pending',
        tier: 'core',
        attempts: 4,
      }],
    };
    mockMutateBacklogAtomically.mockImplementation(
      async (_requirementId: string, mutate: any) => (
        await mutate({ backlog, flow: { phases: [{ id: 'build' }] } })
      ).result,
    );

    await expect(ensureInProgressItem({
      requirementId: 'requirement-1',
    })).resolves.toEqual({
      promoted: null,
      reason: 'no_pending_unblocked',
    });
  });
});
