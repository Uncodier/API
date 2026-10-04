import { randomBytes } from 'node:crypto';
import { boundedChannelModelTurn } from '../bounded-channel-model';
import { CreditService } from '@/lib/services/billing/CreditService';

const mockCreate = jest.fn();
const mockClientOptions = jest.fn();
jest.mock('openai', () => ({ __esModule: true, default: class {
  constructor(options: any) { mockClientOptions(options); }
  chat = { completions: { create: mockCreate } };
} }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: {
  validateCredits: jest.fn(), deductCredits: jest.fn(),
  PRICING: { ASSISTANT_INPUT_TOKEN_MILLION: 1, ASSISTANT_OUTPUT_TOKEN_MILLION: 20 },
} }));

const billing = { siteId: 'site-offline', instanceId: 'instance', runPlanId: 'run', stepId: 'step', messageId: 'message', attempt: 1 };
const capture = { tool: { name: 'plan_result', description: 'Return result', parameters: {},
  execute: jest.fn().mockResolvedValue({ accepted: true }) }, getResult: jest.fn(() => ({ status: 'completed' })) };
const turn = () => boundedChannelModelTurn({ prompt: 'Analyze', userContent: 'Hi', billing, capture: capture as any });
const completion = (usage: any) => ({ id: 'generation-offline', model: 'openai/actual-model', usage,
  choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'plan_result', arguments: '{}' } }] } }] });
const originalEnv = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  jest.mocked(CreditService.validateCredits).mockResolvedValue(true);
  jest.mocked(CreditService.deductCredits).mockResolvedValue({ success: true } as any);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

it.each([0, 0.023, undefined])('uses OpenRouter and preserves reported cost=%s without repricing credits', async cost => {
  process.env.ROBOT_SDK_PROVIDER = 'gemini';
  process.env.AI_MODEL = 'stale-model';
  const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
    ...(cost !== undefined ? { cost, cost_details: { upstream_inference_cost: 0.01 }, is_byok: false } : {}) };
  mockCreate.mockResolvedValue(completion(usage));
  await turn();
  expect(mockClientOptions).toHaveBeenCalledWith(expect.objectContaining({
    baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY, maxRetries: 0, timeout: 90_000,
  }));
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-6.1-sol', user: billing.siteId, stream: false }),
    expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 90_000, maxRetries: 0 }));
  expect(CreditService.deductCredits).toHaveBeenCalledWith(billing.siteId, 0.002, 'assistant_tokens', expect.any(String),
    expect.objectContaining({ provider: 'openrouter', model: 'openai/actual-model', usage, generation_id: 'generation-offline',
      run_plan_id: billing.runPlanId, retry_count: 0, tokens: 1050 }));
  if (cost === undefined) expect(jest.mocked(CreditService.deductCredits).mock.calls[0][4]?.usage).not.toHaveProperty('cost');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('honors a qualified OpenRouter override and checks ownership before generation', async () => {
  process.env.OPENROUTER_CHAT_MODEL = 'anthropic/example-model';
  const beforeProvider = jest.fn().mockRejectedValue(new Error('Ownership lost'));
  await expect(boundedChannelModelTurn({ prompt: 'Analyze', userContent: 'Hi', billing, capture: capture as any, beforeProvider }))
    .rejects.toThrow('Ownership lost');
  expect(mockCreate).not.toHaveBeenCalled();
  mockCreate.mockResolvedValue(completion({ prompt_tokens: 1, completion_tokens: 1 }));
  await turn();
  expect(mockCreate.mock.calls[0][0].model).toBe('anthropic/example-model');
});

it('fails closed with legacy credentials only', async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
  process.env.OPENAI_API_KEY = randomBytes(24).toString('hex');
  await expect(turn()).rejects.toMatchObject({ terminalRun: true, retryable: false });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
});

it('requires reconciliation for missing usage or unconfirmed billing without another generation', async () => {
  mockCreate.mockResolvedValueOnce(completion(undefined));
  await expect(turn()).rejects.toMatchObject({ terminalRun: true, retryable: false });
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
  mockCreate.mockResolvedValueOnce(completion({ prompt_tokens: 1, completion_tokens: 1 }));
  jest.mocked(CreditService.deductCredits).mockResolvedValueOnce({ success: false } as any);
  await expect(turn()).rejects.toMatchObject({ terminalRun: true, retryable: false });
  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
});