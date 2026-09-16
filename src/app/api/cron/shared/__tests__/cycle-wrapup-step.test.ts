import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import { emitCycleWrapUpStep } from '../cycle-wrapup-step';

jest.mock('@/lib/services/robot-instance/assistant-executor', () => ({
  executeAssistantStep: jest.fn(),
}));
jest.mock('@/lib/services/instance-user-history', () => ({
  loadUserActionHistory: jest.fn(),
}));
jest.mock('@/lib/services/docs-cycle-digest', () => ({
  loadLatestDocsDigestFromLogs: jest.fn(),
  formatDigestForPrompt: jest.fn(() => ''),
}));
jest.mock('@/app/api/agents/tools/requirement_status/assistantProtocol', () => ({
  requirementStatusTool: jest.fn(() => ({ name: 'requirement_status' })),
}));
jest.mock('@/lib/tools/requirement-status-core', () => ({
  createRequirementStatusCore: jest.fn(),
}));

const baseParams = {
  siteId: 'site-1',
  instanceId: 'instance-1',
  requirementId: 'requirement-1',
  title: 'Continue implementation',
  instructions: 'Finish the active plan',
  digest: null,
  planCompleted: false,
};

describe('emitCycleWrapUpStep outcomes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadUserActionHistory as jest.Mock).mockResolvedValue({
      promptText: '',
      mode: 'empty',
      totalCount: 1,
    });
  });

  it('reports an intentional skip while plan steps remain', async () => {
    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 2,
    });

    expect(result).toEqual({ ran: false, outcome: 'skipped' });
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('reports a failed execution so the workflow can retry it', async () => {
    (executeAssistantStep as jest.Mock).mockRejectedValue(new Error('provider unavailable'));

    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 0,
    });

    expect(result).toEqual({ ran: false, outcome: 'failed' });
  });

  it('reports successful completion separately from skips', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Done' }],
      isDone: true,
    });

    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 0,
    });

    expect(result).toEqual({ ran: true, outcome: 'completed' });
  });
});
