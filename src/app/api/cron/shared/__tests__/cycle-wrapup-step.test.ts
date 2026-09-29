import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import { createRequirementStatusCore } from '@/lib/tools/requirement-status-core';
import {
  hasRetryablePlanFailure,
  hasRunnableRequirementPlan,
} from '../cycle-wrapup-retry-policy';
import { emitCycleWrapUpStep } from '../cycle-wrapup-step';
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import { buildCycleWrapUpSystemPrompt } from '@/lib/services/cycle-wrapup-prompt';

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
jest.mock('@/lib/services/cycle-wrapup-prompt', () => {
  const actual = jest.requireActual('@/lib/services/cycle-wrapup-prompt');
  return { ...actual, buildCycleWrapUpSystemPrompt: jest.fn(actual.buildCycleWrapUpSystemPrompt) };
});
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
    (executeAssistantStep as jest.Mock).mockReset();
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

  it.each([undefined, false, true])(
    'forces internal review without customer feedback when incoming feedback is %s',
    async requiresUserFeedback => {
      (loadUserActionHistory as jest.Mock).mockResolvedValue({
        promptText: '', mode: 'empty', totalCount: 0,
      });
      (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(true);
      (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(true);
      (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
      const wrapUpReason = 'Build failed: SQLSTATE 42P01 relation "private.customer_secrets" does not exist';

      const result = await emitCycleWrapUpStep({
        ...baseParams,
        pendingPlanSteps: 2,
        hasRunnableBacklogWork: true,
        forceWrapUp: false,
        recoveryDisposition: 'internal_review',
        requiresUserFeedback,
        wrapUpReason,
      });

      expect(result).toEqual({ ran: true, outcome: 'completed' });
      expect(createRequirementStatusCore).toHaveBeenCalledTimes(1);
      expect(createRequirementStatusCore).toHaveBeenCalledWith({
        site_id: baseParams.siteId,
        instance_id: baseParams.instanceId,
        requirement_id: baseParams.requirementId,
        stage: 'blocked',
        message: expect.stringContaining('Technical/platform review is required'),
      });
      expect((createRequirementStatusCore as jest.Mock).mock.invocationCallOrder[0])
        .toBeLessThan((executeAssistantStep as jest.Mock).mock.invocationCallOrder[0]);
      expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        internalReviewRequired: true,
        requiresUserFeedback: false,
        wrapUpReason: expect.not.stringContaining('SQLSTATE'),
      }));
      const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
      expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
      expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
      expect(prompt).not.toContain(wrapUpReason);
      expect(prompt).not.toContain('private.customer_secrets');
      expect(hasRetryablePlanFailure).not.toHaveBeenCalled();
      expect(hasRunnableRequirementPlan).not.toHaveBeenCalled();
    },
  );

  it('reports internal review even without pending work, digest, history, or an explicit force flag', async () => {
    (loadUserActionHistory as jest.Mock).mockResolvedValue({
      promptText: '', mode: 'empty', totalCount: 0,
    });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });

    await expect(emitCycleWrapUpStep({
      ...baseParams,
      planCompleted: true,
      recoveryDisposition: 'internal_review',
    })).resolves.toEqual({ ran: true, outcome: 'completed' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
  });

  it.each(['in-progress', 'on-review', 'completed', 'done', 'blocked', undefined])(
    'clamps model stage %s to the bound internal-review hold, even when the model reports success',
    async stage => {
      (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
        await options.custom_tools[0].execute({
          action: 'create', requirement_id: 'other', instance_id: 'other', stage,
          message: 'SQLSTATE 42P01: review queued and active; continuing automatically.',
        });
        await options.custom_tools[0].execute({
          requirement_id: 'other', instance_id: 'other', stage: 'in-progress',
        });
        return { messages: [{ role: 'assistant', content: 'Successfully completed' }], isDone: true };
      });

      await expect(emitCycleWrapUpStep({
        ...baseParams,
        recoveryDisposition: 'internal_review',
        requiresUserFeedback: true,
      })).resolves.toEqual({ ran: true, outcome: 'completed' });

      const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
      expect(originalTool.execute).toHaveBeenCalledTimes(2);
      for (const [args] of originalTool.execute.mock.calls) {
        expect(args).toEqual(expect.objectContaining({
          requirement_id: baseParams.requirementId,
          instance_id: baseParams.instanceId,
          stage: 'blocked',
          message: expect.stringContaining('No customer approval is needed'),
        }));
        expect(args.message).not.toMatch(/SQLSTATE|queued|active|automatically/);
      }
      expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    },
  );

  it('binds internal-review status reads to the current requirement and instance', async () => {
    (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
      await options.custom_tools[0].execute({ action: 'list', requirement_id: 'other', instance_id: 'other' });
      return { messages: [], isDone: true };
    });

    await emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'internal_review' });
    const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
    expect(originalTool.execute).toHaveBeenCalledWith({
      action: 'list', requirement_id: baseParams.requirementId, instance_id: baseParams.instanceId,
    });
  });

  it.each([undefined, 'blocked'] as const)(
    'preserves concrete customer decisions for legacy/blocked disposition %s',
    async recoveryDisposition => {
      (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
        await options.custom_tools[0].execute({ requirement_id: 'other', stage: 'in-progress' });
        return { messages: [], isDone: true };
      });
      const wrapUpReason = 'Choose the subscription tier and provide the required API credential.';

      await emitCycleWrapUpStep({
        ...baseParams, forceWrapUp: true, recoveryDisposition, requiresUserFeedback: true, wrapUpReason,
      });

      expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'blocked', message: wrapUpReason,
      }));
      expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        internalReviewRequired: false, requiresUserFeedback: true,
      }));
      const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
      expect(prompt).toContain('USER FEEDBACK REQUIRED');
      expect(prompt).toContain('explicitly ask the user to reply');
      const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
      expect(originalTool.execute).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    },
  );

  it('retains the internal-review hold if the reporting assistant fails', async () => {
    (executeAssistantStep as jest.Mock).mockRejectedValue(new Error('provider unavailable'));

    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'internal_review' }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(createRequirementStatusCore).toHaveBeenCalledTimes(1);
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
  });

  it('persists the internal-review hold before loading reporting context that may fail', async () => {
    (loadUserActionHistory as jest.Mock).mockRejectedValueOnce(new Error('history unavailable'));

    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'internal_review' }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('does not claim reporting success if the internal-review status cannot be persisted', async () => {
    (createRequirementStatusCore as jest.Mock).mockRejectedValueOnce(new Error('database unavailable'));
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });

    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'internal_review' }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('does not report completion when the wrap-up itself exhausts its turns', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: false });
    await expect(emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(3);
  });
});
