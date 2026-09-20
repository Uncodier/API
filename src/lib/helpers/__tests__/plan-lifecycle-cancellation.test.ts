import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const mockRpc = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: mockRpc },
}));

import { cancelPlanStepsForBacklogItem } from '../plan-lifecycle';

describe('cancelPlanStepsForBacklogItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('atomically cancels all affected items in one database call', async () => {
    mockRpc.mockResolvedValue({
      data: {
        plans_touched: 1,
        plans_cancelled: 1,
        steps_cancelled: 2,
        plan_ids: ['plan-1'],
        errors: [],
      },
      error: null,
    });

    await expect(cancelPlanStepsForBacklogItem({
      requirementId: 'requirement-1',
      instanceId: 'instance-1',
      itemId: 'item-1',
      affectedItemIds: ['item-1', 'item-2'],
      reason: 'item exhausted',
    })).resolves.toEqual({
      plansTouched: 1,
      plansCancelled: 1,
      stepsCancelled: 2,
      planIds: ['plan-1'],
      errors: [],
    });

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      'cancel_requirement_plan_steps_for_backlog_items',
      {
        p_requirement_id: 'requirement-1',
        p_item_ids: ['item-1', 'item-2'],
        p_reason: 'item exhausted',
        p_instance_id: 'instance-1',
      },
    );
  });

  it('reports an atomic cancellation failure to callers', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(cancelPlanStepsForBacklogItem({
      requirementId: 'requirement-1',
      itemId: 'item-1',
      reason: 'item exhausted',
    })).resolves.toEqual({
      plansTouched: 0,
      plansCancelled: 0,
      stepsCancelled: 0,
      planIds: [],
      errors: ['cancel_plan_steps: database unavailable'],
    });
  });

  it('rejects malformed RPC output instead of hiding cancellation loss', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await expect(cancelPlanStepsForBacklogItem({
      requirementId: 'requirement-1',
      itemId: 'item-1',
      reason: 'item exhausted',
    })).resolves.toMatchObject({
      errors: ['cancel_plan_steps: RPC returned an invalid result'],
    });
  });
});
