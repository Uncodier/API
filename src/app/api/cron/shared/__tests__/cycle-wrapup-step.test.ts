import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import { createRequirementStatusCore } from '@/lib/tools/requirement-status-core';
import {
  hasRetryablePlanFailure,
  hasRunnableRequirementPlan,
} from '../cycle-wrapup-retry-policy';
import { emitCycleWrapUpStep } from '../cycle-wrapup-step';
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';

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
jest.mock('../cycle-wrapup-retry-policy', () => ({
  hasRetryablePlanFailure: jest.fn(),
  hasRunnableRequirementPlan: jest.fn(),
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
    (requirementStatusTool as jest.Mock).mockReturnValue({
      name: 'requirement_status',
      execute: jest.fn().mockResolvedValue({ success: true }),
    });
    (loadUserActionHistory as jest.Mock).mockResolvedValue({
      promptText: '',
      mode: 'empty',
      totalCount: 1,
    });
    (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(false);
    (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(false);
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

  it('keeps the requirement in progress when a failed step can retry', async () => {
    (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(true);
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Continuing' }],
      isDone: true,
    });

    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 2,
      forceWrapUp: true,
      requiresUserFeedback: true,
      wrapUpReason:
        'One or more execution steps failed and need user feedback before continuing.',
    });

    expect(result).toEqual({ ran: true, outcome: 'completed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'in-progress',
        message: expect.stringContaining('retries remaining'),
      }),
    );
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'blocked' }),
    );
    expect(executeAssistantStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        system_prompt: expect.stringContaining(
          'Do NOT ask the user for permission',
        ),
      }),
    );
  });

  it('blocks when a failed step has exhausted its retries', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Blocked' }],
      isDone: true,
    });

    await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 1,
      forceWrapUp: true,
      requiresUserFeedback: true,
      wrapUpReason:
        'One or more execution steps failed and need user feedback before continuing.',
    });

    expect(createRequirementStatusCore).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'blocked' }),
    );
  });

  it('keeps an auto-repairable build failure in progress', async () => {
    (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(true);
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Continuing' }],
      isDone: true,
    });

    await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 2,
      forceWrapUp: true,
      requiresUserFeedback: true,
      wrapUpReason: 'Build failed (npm run build, exit 1): invalid JSX',
    });

    expect(createRequirementStatusCore).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'in-progress' }),
    );
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'blocked' }),
    );
  });

  it('uses typed retry policy regardless of error wording or plan availability', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true,
      requiresUserFeedback: true, recoveryDisposition: 'retry',
      wrapUpReason: 'The work cycle stopped because of an error: Transient database unavailable' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    expect(hasRetryablePlanFailure).not.toHaveBeenCalled();
    expect(hasRunnableRequirementPlan).not.toHaveBeenCalled();
  });

  it('does not allow the model to override recovery policy or target another requirement', async () => {
    (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
      await options.custom_tools[0].execute({ requirement_id: 'other', instance_id: 'other', stage: 'completed' });
      return { messages: [], isDone: true };
    });
    await emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true, recoveryDisposition: 'retry' });
    const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
    expect(originalTool.execute).toHaveBeenCalledWith(expect.objectContaining({
      requirement_id: baseParams.requirementId, instance_id: baseParams.instanceId, stage: 'in-progress',
    }));
  });

  it('does not report completion when the wrap-up itself exhausts its turns', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: false });
    await expect(emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(3);
  });
});
