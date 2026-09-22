const mockUpdateEq = jest.fn();
const mockFinishClaim = jest.fn();
const mockClaim = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table !== 'instance_plans') {
        throw new Error(`Unexpected table ${table}`);
      }
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn().mockResolvedValue({
              data: {
                id: 'plan-1',
                instance_id: 'instance-1',
                site_id: 'site-1',
                metadata: { workflow_run: true },
                steps: [],
              },
              error: null,
            }),
          })),
        })),
        update: jest.fn(() => ({ eq: mockUpdateEq })),
      };
    }),
  },
}));
jest.mock('@/app/api/agents/tools/instance_plan/update/route', () => ({
  updateInstancePlanCore: jest.fn(),
}));
jest.mock('@/app/api/robots/instance/assistant/steps', () => ({
  prepareAssistantContext: jest.fn(),
}));
jest.mock('@/app/api/robots/instance/assistant/assistant-turn', () => ({
  processAssistantTurn: jest.fn(),
}));
jest.mock('@/app/api/cron/shared/step-history-builder', () => ({
  fetchStepLogHistoryText: jest.fn(),
}));
jest.mock('@/lib/services/skills-service', () => ({
  SkillsService: { getSkillBySlugOrName: jest.fn() },
}));
jest.mock('../sandbox-workspace', () => ({
  ensureWorkflowSandbox: jest.fn(),
  stopWorkflowSandbox: jest.fn(),
}));
jest.mock('../execution-claim', () => ({
  claimWorkflowRunExecution: mockClaim,
  renewWorkflowRunExecutionClaim: jest.fn(),
  finishWorkflowRunExecution: mockFinishClaim,
}));

import { runWorkflowPlan } from '../run-plan';

describe('runWorkflowPlan claim recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaim.mockResolvedValue({
      token: 'claim-token',
      expiresAt: '2026-09-19T01:00:00.000Z',
    });
    mockFinishClaim.mockResolvedValue(true);
  });

  it('releases the workflow claim when execution throws', async () => {
    mockUpdateEq
      .mockRejectedValueOnce(new Error('plan update failed'))
      .mockResolvedValueOnce({ error: null });

    await expect(runWorkflowPlan('plan-1'))
      .rejects.toThrow('plan update failed');

    expect(mockFinishClaim).toHaveBeenCalledWith(
      'plan-1',
      'claim-token',
      'pending',
      'plan update failed',
    );
    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
  });
});
