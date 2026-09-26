// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's TS target.
import { jest } from '@jest/globals';

let plan: any;
const updateEq = jest.fn();
const updatePlan = jest.fn();
const prepareAssistantContext = jest.fn();
const processAssistantTurn = jest.fn();

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: plan, error: null }) }) }),
    update: () => ({ eq: updateEq }),
  }) },
}));
jest.unstable_mockModule('@/app/api/agents/tools/instance_plan/update/route', () => ({ updateInstancePlanCore: updatePlan }));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/steps', () => ({ prepareAssistantContext }));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/assistant-turn', () => ({ processAssistantTurn }));
jest.unstable_mockModule('@/app/api/cron/shared/step-history-builder', () => ({ fetchStepLogHistoryText: jest.fn() }));
jest.unstable_mockModule('@/lib/services/skills-service', () => ({ SkillsService: { getSkillBySlugOrName: jest.fn() } }));
jest.unstable_mockModule('../sandbox-workspace', () => ({ ensureWorkflowSandbox: jest.fn(), stopWorkflowSandbox: jest.fn() }));
jest.unstable_mockModule('../execution-claim', () => ({
  claimWorkflowRunExecution: async () => ({ token: 'claim-token' }),
  renewWorkflowRunExecutionClaim: async () => true,
  finishWorkflowRunExecution: async () => true,
}));

const { runWorkflowPlan } = await import('../run-plan');

beforeEach(() => {
  jest.clearAllMocks();
  updateEq.mockResolvedValue({ error: null });
  plan = {
    id: 'plan-1', instance_id: 'instance-1', site_id: 'site-1', user_id: 'user-1',
    title: 'Workflow', metadata: { workflow_run: true },
    steps: [
      { id: 'step_1', order: 1, title: 'Check', status: 'pending', type: 'task',
        instructions: 'Check the lead', max_retries: 0, metadata: { node_id: 'check' } },
      { id: 'step_2', order: 2, title: 'Happy path', status: 'pending', type: 'task',
        instructions: 'Write success', metadata: { node_id: 'success', parent_node_id: 'check', relation_context: 'on success' } },
      { id: 'step_3', order: 3, title: 'Failure path', status: 'pending', type: 'task',
        instructions: 'Handle failure', max_retries: 0,
        metadata: { node_id: 'failure', parent_node_id: 'check', relation_context: 'on fail' } },
    ],
  };
});

it('executes on fail after retries are exhausted, skips on success, and sends the relation to the agent', async () => {
  const prompts: string[] = [];
  prepareAssistantContext.mockImplementation(async (
    _id, _message, _site, _user, customTools, _useSdk, systemPrompt,
  ) => {
    prompts.push(systemPrompt);
    return { customTools, executionOptions: {} };
  });
  processAssistantTurn.mockImplementation(async (context) => {
    const resultTool = context.customTools.find((tool) => tool.name === 'plan_result');
    if (prompts.length === 1) {
      await resultTool.execute({ status: 'failed', summary: 'Lead check failed', error: { message: 'Not found', retryable: false },
        data: {}, evidence: [], criteria: [], validation: [] });
    } else {
      await context.toolExecutionTracker.track('report', {}, async () => ({ ok: true }));
      await resultTool.execute({ status: 'completed', summary: 'Failure handled', data: {}, evidence: [], criteria: [], validation: [] });
    }
    return { messages: [], isDone: false, text: '' };
  });

  await expect(runWorkflowPlan('plan-1')).resolves.toMatchObject({ status: 'completed', steps_completed: 1 });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('Incoming relation: on fail');
  expect(prompts[1]).toContain('Not found');
  expect(updatePlan).toHaveBeenCalledWith(expect.objectContaining({
    steps: [expect.objectContaining({ id: 'step_2', status: 'cancelled' })],
  }));
});

it('passes custom relation context and previous outputs to the agent, which can skip it safely', async () => {
  plan.steps = [
    { id: 'step_1', order: 1, title: 'Check', status: 'completed', type: 'task',
      result: { status: 'completed', data: { approved: false } }, metadata: { node_id: 'check' } },
    { id: 'step_2', order: 2, title: 'Send follow-up', status: 'pending', type: 'task',
      instructions: 'Send follow-up', metadata: {
        node_id: 'follow-up', parent_node_id: 'check', relation_context: 'when approved by customer',
      } },
  ];
  let receivedPrompt = '';
  prepareAssistantContext.mockImplementation(async (
    _id, _message, _site, _user, customTools, _useSdk, systemPrompt,
  ) => {
    receivedPrompt = systemPrompt;
    return { customTools, executionOptions: {} };
  });
  processAssistantTurn.mockImplementation(async (context) => {
    const resultTool = context.customTools.find((tool) => tool.name === 'plan_result');
    await resultTool.execute({ status: 'skipped', summary: 'Customer has not approved.', data: {},
      evidence: [], criteria: [], validation: [] });
    return { messages: [], isDone: false, text: '' };
  });

  await expect(runWorkflowPlan('plan-1')).resolves.toMatchObject({ status: 'completed', steps_completed: 1 });
  expect(receivedPrompt).toContain('Incoming relation: when approved by customer');
  expect(receivedPrompt).toContain('"approved": false');
  expect(updatePlan).toHaveBeenCalledWith(expect.objectContaining({
    steps: [expect.objectContaining({ id: 'step_2', status: 'cancelled' })],
  }));
});