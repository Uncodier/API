const mockRpc = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<{ data: any; error: any }>
>;

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    rpc: mockRpc,
  },
}));

import { resumeRequirementExecutionOnUserAction } from '../requirement-execution-recovery';

describe('resumeRequirementExecutionOnUserAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockResolvedValue({
      data: { plans_updated: 1, steps_cleared: 1 },
      error: null,
    });
  });

  it('clears circuits and resumes plans through one atomic RPC', async () => {
    await resumeRequirementExecutionOnUserAction(
      'requirement-1',
      'instance-1',
      true,
      'user-action-1',
    );

    expect(mockRpc).toHaveBeenCalledWith(
      'resume_instance_execution_on_user_action',
      {
        p_requirement_id: 'requirement-1',
        p_instance_id: 'instance-1',
        p_reopen_paused_plans: true,
        p_action_id: 'user-action-1',
        p_allow_terminal_reopen: false,
      },
    );
  });

  it('surfaces recovery database failures', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'serialization failure' },
    });

    await expect(
      resumeRequirementExecutionOnUserAction(
        'requirement-1',
        'instance-1',
        false,
        'user-action-1',
      ),
    ).rejects.toThrow('serialization failure');
  });
});
