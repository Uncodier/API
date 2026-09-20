import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFrom = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom },
}));

import {
  markPlanAsStarted,
  updatePlanWithStepResult,
} from '../robot-plan-execution/plan-manager';

function readBuilder(plan: Record<string, unknown>) {
  const builder: any = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.single = jest.fn().mockResolvedValue({ data: plan, error: null });
  return builder;
}

function racedWriteBuilder() {
  const builder: any = {};
  builder.update = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.in = jest.fn(() => builder);
  builder.is = jest.fn(() => builder);
  builder.select = jest.fn(() => builder);
  builder.maybeSingle = jest.fn().mockResolvedValue({
    data: null,
    error: null,
  });
  return builder;
}

describe('plan manager optimistic concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not restore a cancelled step when cancellation wins the result race', async () => {
    const plan = {
      id: 'plan-1',
      status: 'in_progress',
      updated_at: '2026-09-20T01:00:00.000Z',
      steps: [{ id: 'step-1', status: 'in_progress' }],
    };
    const write = racedWriteBuilder();
    mockFrom
      .mockReturnValueOnce(readBuilder(plan))
      .mockReturnValueOnce(write);

    await expect(updatePlanWithStepResult(
      'plan-1',
      { id: 'step-1' },
      'completed',
      'done',
      Date.now(),
      plan.steps,
    )).rejects.toThrow(/changed concurrently/);

    expect(write.eq).toHaveBeenCalledWith('updated_at', plan.updated_at);
    expect(write.in).toHaveBeenCalledWith(
      'status',
      ['pending', 'in_progress', 'active'],
    );
  });

  it('does not start a stale step when cancellation wins the start race', async () => {
    const plan = {
      id: 'plan-1',
      status: 'pending',
      updated_at: '2026-09-20T01:00:00.000Z',
      steps: [{ id: 'step-1', status: 'pending' }],
    };
    const write = racedWriteBuilder();
    mockFrom
      .mockReturnValueOnce(readBuilder(plan))
      .mockReturnValueOnce(write);

    await expect(markPlanAsStarted(
      'plan-1',
      plan.steps,
      { id: 'step-1' },
    )).rejects.toThrow(/changed concurrently/);

    expect(write.eq).toHaveBeenCalledWith('updated_at', plan.updated_at);
    expect(write.in).toHaveBeenCalledWith(
      'status',
      ['pending', 'in_progress', 'active'],
    );
  });

  it('does not persist a step result for an already paused plan', async () => {
    const plan = {
      id: 'plan-1',
      status: 'paused',
      updated_at: '2026-09-20T01:00:00.000Z',
      steps: [{ id: 'step-1', status: 'in_progress' }],
    };
    mockFrom.mockReturnValueOnce(readBuilder(plan));

    await expect(updatePlanWithStepResult(
      'plan-1',
      { id: 'step-1' },
      'completed',
      'done',
      Date.now(),
      plan.steps,
    )).rejects.toThrow(/no longer runnable/);

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('does not start a pending step for an already paused plan', async () => {
    const plan = {
      id: 'plan-1',
      status: 'paused',
      updated_at: '2026-09-20T01:00:00.000Z',
      steps: [{ id: 'step-1', status: 'pending' }],
    };
    mockFrom.mockReturnValueOnce(readBuilder(plan));

    await expect(markPlanAsStarted(
      'plan-1',
      plan.steps,
      { id: 'step-1' },
    )).rejects.toThrow(/no longer runnable/);

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
