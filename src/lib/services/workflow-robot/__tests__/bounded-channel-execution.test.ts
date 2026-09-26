// @ts-nocheck -- ESM Jest mocks are dynamically imported under the ES5 TS target.
import { jest } from '@jest/globals';

const from = jest.fn();
const rpc = jest.fn();
const loadBoundChannelMessageRun = jest.fn();
const buildWorkflowStepPrompt = jest.fn();
const chatCreate = jest.fn();
const capture = jest.fn();
const validateCredits = jest.fn();
const deductCredits = jest.fn();
let plan: any;

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from, rpc } }));
jest.unstable_mockModule('../channel-message', () => ({ loadBoundChannelMessageRun }));
jest.unstable_mockModule('../step-prompt', () => ({ buildWorkflowStepPrompt }));
jest.unstable_mockModule('../plan-result', () => ({ createWorkflowPlanResultCapture: capture }));
jest.unstable_mockModule('@/lib/services/billing/CreditService', () => ({ CreditService: {
  validateCredits, deductCredits, PRICING: { ASSISTANT_INPUT_TOKEN_MILLION: 1, ASSISTANT_OUTPUT_TOKEN_MILLION: 20 },
} }));
jest.unstable_mockModule('openai', () => ({ default: class OpenAI {
  chat = { completions: { create: chatCreate } };
} }));

const { advanceBoundedChannelMessageRun, boundedChannelModelTurn: modelTurn } =
  await import('../bounded-channel-execution');
const siteId = '11111111-1111-4111-8111-111111111111';
const runPlanId = '22222222-2222-4222-8222-222222222222';
const input = { siteId, runPlanId, messageId: 'message-1' };

beforeEach(() => {
  jest.clearAllMocks();
  validateCredits.mockResolvedValue(true);
  deductCredits.mockResolvedValue({ success: true });
  plan = {
    id: runPlanId, site_id: siteId, instance_id: '33333333-3333-4333-8333-333333333333',
    status: 'pending', metadata: { trigger_payload: { source: 'channel_message', message_id: 'message-1', message: 'Hi' } },
    steps: [{ id: 'step-1', status: 'pending', order: 1, title: 'Analyze', instructions: 'Assess the message' }],
  };
  loadBoundChannelMessageRun.mockImplementation(async () => ({ run: { status: 'pending' }, plan,
    trigger: { config: {} } }));
  from.mockImplementation(() => ({ update: jest.fn(() => ({ eq: jest.fn(() => ({
    eq: jest.fn(() => ({ select: jest.fn(() => ({ maybeSingle: jest.fn().mockResolvedValue({ data: { id: runPlanId }, error: null }) })) })),
    select: jest.fn(() => ({ maybeSingle: jest.fn().mockResolvedValue({ data: { id: runPlanId }, error: null }) })),
  })) })) }));
  rpc.mockImplementation(async (name: string) => ({
    data: name === 'claim_workflow_run_execution' ? { state: 'claimed' } : true, error: null,
  }));
  buildWorkflowStepPrompt.mockReturnValue('Safe workflow prompt');
  capture.mockReturnValue({ tool: { name: 'plan_result', description: '', parameters: {}, execute: jest.fn() }, getResult: jest.fn() });
  chatCreate.mockResolvedValue({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { tool_calls: [{
    type: 'function', function: { name: 'plan_result', arguments: '{}' },
  }] } }] });
});

it('never invokes the model for a terminal or busy run', async () => {
  plan.status = 'completed';
  expect(await advanceBoundedChannelMessageRun(input)).toBe('completed');
  expect(rpc).toHaveBeenCalledWith('finish_workflow_run_execution', expect.objectContaining({ p_status: 'completed' }));
  rpc.mockClear();
  plan.status = 'pending';
  rpc.mockResolvedValueOnce({ data: { state: 'busy' }, error: null });
  expect(await advanceBoundedChannelMessageRun(input)).toBe('already_running');
  expect(chatCreate).not.toHaveBeenCalled();
});

it('fails closed on an interrupted model turn instead of replaying it', async () => {
  plan.status = 'in_progress';
  plan.steps[0].status = 'in_progress';
  expect(await advanceBoundedChannelMessageRun(input)).toBe('failed');
  expect(chatCreate).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('finish_workflow_run_execution', expect.objectContaining({ p_status: 'failed' }));
});

it('runs at most one tool-limited provider turn per advance and persists completed steps', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousProvider = process.env.ROBOT_SDK_PROVIDER;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.ROBOT_SDK_PROVIDER = 'openai';
  const accepted = { status: 'completed', summary: 'Advised the support team', data: {}, evidence: [],
    criteria: [], validation: [] };
  capture.mockImplementation(() => ({ tool: { name: 'plan_result', description: 'Result', parameters: {},
    execute: jest.fn().mockResolvedValue({ accepted: true }) }, getResult: jest.fn(() => accepted) }));
  plan.steps.push({ id: 'step-2', status: 'pending', order: 2, title: 'Summarize', instructions: 'Summarize' });
  try {
    expect(await advanceBoundedChannelMessageRun(input)).toBe('in_progress');
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(plan.steps[0]).toMatchObject({ status: 'completed', result: { turns: 1 } });
    expect(plan.steps[1].status).toBe('pending');
    expect(await advanceBoundedChannelMessageRun(input)).toBe('completed');
    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(plan.steps[1].status).toBe('completed');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.ROBOT_SDK_PROVIDER;
    else process.env.ROBOT_SDK_PROVIDER = previousProvider;
  }
});

it('rejects a response without exactly one plan_result tool call', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  chatCreate.mockResolvedValueOnce({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { tool_calls: [] } }] });
  try {
    await expect(modelTurn({ provider: 'openai', prompt: 'Only analysis', userContent: 'Hi',
      billing: { siteId, runPlanId, instanceId: 'instance', stepId: 'step-1', messageId: input.messageId, attempt: 1 },
      capture: { tool: { name: 'plan_result', description: 'Return result', parameters: {}, execute: jest.fn() }, getResult: jest.fn() },
    })).rejects.toThrow('A single plan_result call is required');
    expect(chatCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: false, tool_choice: {
      type: 'function', function: { name: 'plan_result' },
    } }), expect.objectContaining({ timeout: 90_000, maxRetries: 0, signal: expect.any(AbortSignal) }));
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});