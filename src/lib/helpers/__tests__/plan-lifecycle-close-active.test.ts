import { describe, expect, it, jest } from '@jest/globals';

const fetchQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  in: jest.fn(),
  neq: jest.fn(),
  lt: jest.fn(),
};
fetchQuery.select.mockReturnValue(fetchQuery);
fetchQuery.eq.mockReturnValue(fetchQuery);
fetchQuery.in.mockReturnValue(fetchQuery);
fetchQuery.neq.mockReturnValue(fetchQuery);

const updateEq = jest.fn(async () => ({ error: null }));
const update = jest.fn(() => ({ eq: updateEq }));
const from = jest.fn()
  .mockReturnValueOnce(fetchQuery)
  .mockReturnValue({ update });

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));

describe('completeInProgressPlans', () => {
  it('only closes plans older than the newly-created replacement', async () => {
    fetchQuery.lt.mockResolvedValueOnce({
      data: [{
        id: 'old-plan',
        status: 'in_progress',
        steps: [{ id: 'step-1', status: 'pending' }],
        metadata: {},
      }],
      error: null,
    });
    const { completeInProgressPlans } = await import('../plan-lifecycle');

    await expect(completeInProgressPlans(
      'instance-1',
      'Superseded by plan new-plan',
      {
        excludePlanId: 'new-plan',
        createdBefore: '2026-09-16T04:00:00.000Z',
      },
    )).resolves.toMatchObject({
      success: true,
      completedCount: 1,
    });

    expect(fetchQuery.neq).toHaveBeenCalledWith('id', 'new-plan');
    expect(fetchQuery.lt).toHaveBeenCalledWith(
      'created_at',
      '2026-09-16T04:00:00.000Z',
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      steps: [expect.objectContaining({ id: 'step-1', status: 'cancelled' })],
    }));
  });
});
