import { jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  claimWorkflowRunExecution,
  finishWorkflowRunExecution,
  renewWorkflowRunExecutionClaim,
} from '../execution-claim';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    rpc: jest.fn(),
  },
}));

describe('claimWorkflowRunExecution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the token for a claimed run', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: {
        state: 'claimed',
        claim_expires_at: '2026-09-19T01:00:00.000Z',
      },
      error: null,
    } as never);

    const claim = await claimWorkflowRunExecution('plan-1');

    expect(claim).toEqual({
      token: expect.any(String),
      expiresAt: '2026-09-19T01:00:00.000Z',
    });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      'claim_workflow_run_execution',
      expect.objectContaining({
        p_run_plan_id: 'plan-1',
        p_claim_token: claim?.token,
      }),
    );
  });

  it('rejects an already claimed run', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: { state: 'busy' },
      error: null,
    } as never);

    await expect(claimWorkflowRunExecution('plan-1')).resolves.toBeNull();
  });

  it('surfaces database claim failures', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    } as never);

    await expect(claimWorkflowRunExecution('plan-1'))
      .rejects.toThrow('Failed to claim workflow run: database unavailable');
  });

  it('renews and finalizes with the same fencing token', async () => {
    (supabaseAdmin.rpc as jest.Mock)
      .mockResolvedValueOnce({ data: true, error: null } as never)
      .mockResolvedValueOnce({ data: true, error: null } as never);

    await expect(renewWorkflowRunExecutionClaim(
      'plan-1',
      'claim-token',
    )).resolves.toBe(true);
    await expect(finishWorkflowRunExecution(
      'plan-1',
      'claim-token',
      'completed',
    )).resolves.toBe(true);

    expect(supabaseAdmin.rpc).toHaveBeenNthCalledWith(
      1,
      'renew_workflow_run_execution_claim',
      expect.objectContaining({ p_claim_token: 'claim-token' }),
    );
    expect(supabaseAdmin.rpc).toHaveBeenNthCalledWith(
      2,
      'finish_workflow_run_execution',
      expect.objectContaining({
        p_claim_token: 'claim-token',
        p_status: 'completed',
      }),
    );
  });
});
