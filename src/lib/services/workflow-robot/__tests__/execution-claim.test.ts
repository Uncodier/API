import { jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { claimWorkflowRunExecution } from '../execution-claim';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function mockClaimResult(result: { data: unknown; error: { message: string } | null }) {
  const chain = {
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result as never),
  };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);
  return chain;
}

describe('claimWorkflowRunExecution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims a pending run exactly once', async () => {
    const chain = mockClaimResult({ data: { id: 'run-1' }, error: null });

    await expect(claimWorkflowRunExecution('plan-1')).resolves.toBe(true);
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'run_plan_id', 'plan-1');
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'status', 'pending');
  });

  it('rejects an already claimed run', async () => {
    mockClaimResult({ data: null, error: null });

    await expect(claimWorkflowRunExecution('plan-1')).resolves.toBe(false);
  });

  it('surfaces database claim failures', async () => {
    mockClaimResult({ data: null, error: { message: 'database unavailable' } });

    await expect(claimWorkflowRunExecution('plan-1'))
      .rejects.toThrow('Failed to claim workflow run: database unavailable');
  });
});
