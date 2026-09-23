const mockUpdateEq = jest.fn();
const mockFinishClaim = jest.fn();
const mockClaim = jest.fn();
const mockRenewClaim = jest.fn();
const mockUpdatePlan = jest.fn();
const mockPrepareAssistantContext = jest.fn();
const mockProcessAssistantTurn = jest.fn();
const mockEnsureWorkflowSandbox = jest.fn();
const mockStopWorkflowSandbox = jest.fn();
let mockPlan: Record<string, any>;

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
              data: mockPlan,
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
  updateInstancePlanCore: mockUpdatePlan,
}));
jest.mock('@/app/api/robots/instance/assistant/steps', () => ({
  prepareAssistantContext: mockPrepareAssistantContext,
}));
jest.mock('@/app/api/robots/instance/assistant/assistant-turn', () => ({
  processAssistantTurn: mockProcessAssistantTurn,
}));
jest.mock('@/app/api/cron/shared/step-history-builder', () => ({
  fetchStepLogHistoryText: jest.fn(),
}));
jest.mock('@/lib/services/skills-service', () => ({
  SkillsService: { getSkillBySlugOrName: jest.fn() },
}));
jest.mock('../sandbox-workspace', () => ({
  ensureWorkflowSandbox: mockEnsureWorkflowSandbox,
  stopWorkflowSandbox: mockStopWorkflowSandbox,
}));
jest.mock('../execution-claim', () => ({
  claimWorkflowRunExecution: mockClaim,
  renewWorkflowRunExecutionClaim: mockRenewClaim,
  finishWorkflowRunExecution: mockFinishClaim,
}));

import { runWorkflowPlan } from '../run-plan';

describe('runWorkflowPlan claim recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlan = {
      id: 'plan-1',
      instance_id: 'instance-1',
      site_id: 'site-1',
      user_id: 'user-1',
      parent_plan_id: 'template-1',
      title: 'Workflow run',
      metadata: { workflow_run: true, dry_run: false },
      steps: [],
    };
    mockClaim.mockResolvedValue({
      token: 'claim-token',
      expiresAt: '2026-09-19T01:00:00.000Z',
    });
    mockRenewClaim.mockResolvedValue(true);
    mockFinishClaim.mockResolvedValue(true);
    mockUpdateEq.mockResolvedValue({ error: null });
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

  it('persists the structured plan_result before completing a step', async () => {
    mockPlan.steps = [{
      id: 'step-1',
      order: 1,
      title: 'Collect opportunities',
      type: 'task',
      status: 'pending',
      instructions: 'Collect one opportunity.',
      expected_output: '{ opportunities: [] }',
      success_criteria: ['One real opportunity is returned.'],
      validation_rules: [],
      max_retries: 0,
    }];
    mockPrepareAssistantContext.mockImplementation(async (
      _instanceId: string,
      _message: string,
      _siteId: string,
      _userId: string,
      customTools: any[],
    ) => ({ customTools, executionOptions: {} }));
    mockProcessAssistantTurn.mockImplementation(async (context: any) => {
      await context.toolExecutionTracker.track(
        'webSearch',
        { query: 'opportunities' },
        async () => ({ ok: true }),
      );
      const resultTool = context.customTools.find((tool: any) => tool.name === 'plan_result');
      await resultTool.execute({
        status: 'completed',
        summary: 'Collected one opportunity.',
        data: {
          opportunities: [{ url: 'https://example.com/job/1' }],
          total_opportunities: 1,
        },
        evidence: [{ type: 'url', reference: 'https://example.com/job/1' }],
        criteria: [{ index: 1, passed: true, evidence: 'The URL was observed.' }],
        validation: [],
      });
      return { messages: [], isDone: false, text: '' };
    });

    await expect(runWorkflowPlan('plan-1')).resolves.toMatchObject({
      status: 'completed',
      steps_completed: 1,
    });
    expect(mockUpdatePlan).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({
        id: 'step-1',
        status: 'completed',
        result: expect.objectContaining({
          status: 'completed',
          data: expect.objectContaining({ total_opportunities: 1 }),
          turns: 1,
        }),
      })],
    }));
  });

  it('fails instead of completing when turn budget ends without plan_result', async () => {
    mockPlan.steps = [{
      id: 'step-1',
      order: 1,
      title: 'Collect opportunities',
      type: 'task',
      status: 'pending',
      instructions: 'Collect one opportunity.',
      expected_output: '{ opportunities: [] }',
      success_criteria: [],
      validation_rules: [],
      max_retries: 0,
    }];
    mockPrepareAssistantContext.mockImplementation(async (
      _instanceId: string,
      _message: string,
      _siteId: string,
      _userId: string,
      customTools: any[],
    ) => ({ customTools, executionOptions: {} }));
    mockProcessAssistantTurn.mockResolvedValue({
      messages: [],
      isDone: false,
      text: '',
    });

    await expect(runWorkflowPlan('plan-1')).resolves.toMatchObject({
      status: 'failed',
      steps_completed: 0,
    });
    expect(mockProcessAssistantTurn).toHaveBeenCalledTimes(10);
    expect(mockUpdatePlan).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({
        id: 'step-1',
        status: 'failed',
        error_message: expect.stringContaining('without an accepted plan_result'),
      })],
    }));
  });

  it('restores structured outputs from completed steps when a run resumes', async () => {
    mockPlan.steps = [
      {
        id: 'step-1',
        order: 1,
        title: 'Collect opportunities',
        type: 'task',
        status: 'completed',
        actual_output: '{"total_opportunities":1}',
        result: {
          status: 'completed',
          summary: 'Collected one opportunity.',
          data: { total_opportunities: 1 },
          evidence: [],
        },
      },
      {
        id: 'step-2',
        order: 2,
        title: 'Summarize opportunities',
        type: 'task',
        status: 'pending',
        instructions: 'Summarize {{steps.step_1.total_opportunities}} opportunities.',
        expected_output: '{ summary: "" }',
        success_criteria: [],
        validation_rules: [],
        max_retries: 0,
      },
    ];
    let receivedSystemPrompt = '';
    mockPrepareAssistantContext.mockImplementation(async (
      _instanceId: string,
      _message: string,
      _siteId: string,
      _userId: string,
      customTools: any[],
      _useSdkTools: boolean,
      systemPrompt: string,
    ) => {
      receivedSystemPrompt = systemPrompt;
      return { customTools, executionOptions: {} };
    });
    mockProcessAssistantTurn.mockImplementation(async (context: any) => {
      await context.toolExecutionTracker.track(
        'report',
        { action: 'summarize' },
        async () => ({ success: true }),
      );
      const resultTool = context.customTools.find((tool: any) => tool.name === 'plan_result');
      await resultTool.execute({
        status: 'completed',
        summary: 'Summarized the opportunity.',
        data: { summary: 'One opportunity was found.' },
        evidence: [],
        criteria: [],
        validation: [],
      });
      return { messages: [], isDone: false, text: '' };
    });

    await expect(runWorkflowPlan('plan-1')).resolves.toMatchObject({
      status: 'completed',
      steps_completed: 2,
    });
    expect(receivedSystemPrompt).toContain('Summarize 1 opportunities.');
    expect(receivedSystemPrompt).toContain('"total_opportunities": 1');
  });

  it('requests an isolated browser sandbox for the current run', async () => {
    mockPlan.steps = [{
      id: 'step-browser',
      order: 1,
      title: 'Open marketplace',
      type: 'task',
      status: 'pending',
      instructions: 'Open the marketplace.',
      expected_output: '{ title: "" }',
      success_criteria: [],
      validation_rules: [],
      requires_browser: true,
      browser_allowed_domains: ['example.com', '*.example.com'],
      max_retries: 0,
    }];
    mockEnsureWorkflowSandbox.mockResolvedValue({
      sandboxId: 'sandbox-for-plan-1',
      tools: [],
      environmentKeys: ['SERVICE_USER'],
      browserReady: true,
    });
    mockPrepareAssistantContext.mockImplementation(async (
      _instanceId: string,
      _message: string,
      _siteId: string,
      _userId: string,
      customTools: any[],
    ) => ({ customTools, executionOptions: {} }));
    mockProcessAssistantTurn.mockImplementation(async (context: any) => {
      await context.toolExecutionTracker.track(
        'sandbox_browser',
        { action: 'open' },
        async () => ({ ok: true }),
      );
      await context.toolExecutionTracker.track(
        'sandbox_browser',
        { action: 'snapshot' },
        async () => ({ ok: true }),
      );
      const resultTool = context.customTools.find((tool: any) => tool.name === 'plan_result');
      await resultTool.execute({
        status: 'completed',
        summary: 'Opened the marketplace.',
        data: { title: 'Marketplace' },
        evidence: [],
        criteria: [],
        validation: [],
      });
      return { messages: [], isDone: false, text: '' };
    });

    await expect(runWorkflowPlan('plan-1')).resolves.toMatchObject({
      status: 'completed',
    });
    expect(mockEnsureWorkflowSandbox).toHaveBeenCalledWith(expect.objectContaining({
      runPlanId: 'plan-1',
      requiresBrowser: true,
      browserAllowedDomains: ['example.com', '*.example.com'],
      browserSecretNames: [],
    }));
    expect(mockEnsureWorkflowSandbox).not.toHaveBeenCalledWith(
      expect.objectContaining({ runPlanId: 'template-1' }),
    );
    expect(mockStopWorkflowSandbox).toHaveBeenCalledWith('sandbox-for-plan-1');
  });
});
