import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCancelPlanSteps = jest.fn();
const mockMutateBacklogAtomically = jest.fn();

jest.mock('@/lib/helpers/plan-lifecycle', () => ({
  cancelPlanStepsForBacklogItem: mockCancelPlanSteps,
}));
jest.mock('../requirement-backlog-mutation', () => ({
  mutateBacklogAtomically: mockMutateBacklogAtomically,
}));

import { fulfillPlanCancellationRequests } from '../requirement-plan-cancellation';

describe('durable plan cancellation requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the request after failure and clears it after a later retry', async () => {
    const item: any = {
      id: 'item-1',
      status: 'needs_review',
      plan_cancellation_pending: {
        reason: 'attempt envelope exhausted',
        requested_at: '2026-09-20T01:00:00.000Z',
      },
    };
    mockCancelPlanSteps
      .mockResolvedValueOnce({
        plansTouched: 0,
        plansCancelled: 0,
        stepsCancelled: 0,
        planIds: [],
        errors: ['database unavailable'],
      })
      .mockResolvedValueOnce({
        plansTouched: 1,
        plansCancelled: 1,
        stepsCancelled: 1,
        planIds: ['plan-1'],
        errors: [],
      });
    mockMutateBacklogAtomically.mockImplementation(
      async (_requirementId: string, mutate: any) => {
        const backlog = { items: [item] };
        const outcome = await mutate({ backlog });
        Object.assign(item, backlog.items[0]);
        for (const key of Object.keys(item)) {
          if (!(key in backlog.items[0])) delete item[key];
        }
        return outcome.result;
      },
    );
    const request = {
      itemId: item.id,
      reason: item.plan_cancellation_pending.reason,
      requestedAt: item.plan_cancellation_pending.requested_at,
    };

    await expect(fulfillPlanCancellationRequests({
      requirementId: 'requirement-1',
      requests: [request],
    })).rejects.toThrow(/database unavailable/);
    expect(item.plan_cancellation_pending).toBeDefined();
    expect(mockMutateBacklogAtomically).not.toHaveBeenCalled();

    await expect(fulfillPlanCancellationRequests({
      requirementId: 'requirement-1',
      requests: [request],
    })).resolves.toBeUndefined();
    expect(item.plan_cancellation_pending).toBeUndefined();
    expect(mockCancelPlanSteps).toHaveBeenCalledTimes(2);
  });
});
