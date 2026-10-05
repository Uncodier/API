import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import { OpenRouterConnector, PortkeyConnector } from '../PortkeyConnector';
import { parseAgentModel } from '../../models/model-selection';
import { CommandFactory } from '../command/CommandFactory';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));

const create = jest.fn();
const originalEnv = process.env;
const messages = [{ role: 'system' as const, content: 'Support agent instructions.' }, { role: 'user' as const, content: 'Hello' }];
const completion = { choices: [{ message: { content: 'Answer' } }], usage: {
  prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.000123,
  cost_details: { upstream_inference_cost: 0.00012 }, is_byok: false,
} };

beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  create.mockReset().mockResolvedValue(completion);
  (OpenAI as unknown as jest.Mock).mockClear().mockImplementation(() => ({ chat: { completions: { create } } }));
});
afterEach(() => { process.env = originalEnv; });

it('keeps the compatibility export but routes the default only through OpenRouter', async () => {
  expect(PortkeyConnector).toBe(OpenRouterConnector);
  const result = await new PortkeyConnector().callAgent(messages, { siteId: 'site-a', temperature: 0.2, topP: 0.5, reasoningEffort: 'high' });
  expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 }));
  expect(create.mock.calls[0][0]).toMatchObject({ model: 'openai/gpt-6.1-sol', user: 'site-a', reasoning: { effort: 'high' }, stream: false });
  expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  expect(create.mock.calls[0][0]).not.toHaveProperty('top_p');
  expect(result.usage).toEqual(completion.usage);
  expect(result.modelInfo).toEqual({ model: 'openai/gpt-6.1-sol', provider: 'openrouter' });
});

it.each([['anthropic', 'claude-sonnet-4', 'anthropic/claude-sonnet-4'], ['gemini', 'gemini-2.5-flash', 'google/gemini-2.5-flash'], ['openrouter', 'openai/gpt-6.1-sol:extended', 'openai/gpt-6.1-sol:extended']] as const)(
  'normalizes vendor %s but never changes transport', async (modelType, modelId, expected) => {
    await new OpenRouterConnector().callAgent(messages, { modelType, modelId, responseFormat: 'json', maxTokens: 100 });
    expect(create.mock.calls[0][0]).toMatchObject({ model: expected, max_tokens: 100, response_format: { type: 'json_object' } });
    expect(create.mock.calls[0][0]).not.toHaveProperty('maxOutputTokens');
  },
);

it('returns raw streaming chunks and requests usage without another transport', async () => {
  const stream = (async function* () { yield { choices: [], usage: completion.usage }; })();
  create.mockResolvedValue(stream);
  const result = await new OpenRouterConnector().callAgent(messages, { stream: true, siteId: 'site-a' });
  expect(result.stream).toBe(stream);
  expect(result.isStream).toBe(true);
  expect(create.mock.calls[0][0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, user: 'site-a' });
});

it.each(['openai:gpt-5.6', 'openrouter:openai/gpt-5.6-sol'])(
  'migrates persisted command model %s before inference', async commandModel => {
    const options = parseAgentModel(commandModel);
    const result = await new OpenRouterConnector().callAgent(messages, {
      ...options, temperature: 0.2, topP: 0.5, reasoningEffort: 'minimal',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'openai/gpt-6.1-sol', reasoning: { effort: 'low' } });
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(create.mock.calls[0][0]).not.toHaveProperty('top_p');
    expect(result.modelInfo).toEqual({ model: 'openai/gpt-6.1-sol', provider: 'openrouter' });
  },
);

it.each([429, 503])('propagates %s without Portkey, Vercel, or model fallback', async status => {
  const failure = Object.assign(new Error('Provider unavailable'), { status });
  create.mockRejectedValue(failure);
  await expect(new OpenRouterConnector().callAgent(messages)).rejects.toBe(failure);
  expect(create).toHaveBeenCalledTimes(1);
});

it('fails closed without an OpenRouter key even if legacy credentials exist', async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.PORTKEY_API_KEY = randomBytes(24).toString('hex');
  process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
  await expect(new OpenRouterConnector().callAgent(messages)).rejects.toThrow('OPENROUTER_API_KEY');
  expect(create).not.toHaveBeenCalled();
});

it('rejects legacy Portkey credentials before constructing a client', async () => {
  await expect(new PortkeyConnector({ apiKey: randomBytes(24).toString('hex'), virtualKeys: { openai: randomBytes(24).toString('hex') } })
    .callAgent(messages)).rejects.toThrow('Legacy Portkey/Azure credentials');
  expect(OpenAI).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it('preserves variant suffixes in both qualified and legacy combined command model fields', () => {
  expect(parseAgentModel('openrouter:vendor/model:free')).toEqual({ modelType: 'openrouter', modelId: 'vendor/model:free' });
  expect(parseAgentModel('vendor/model:free')).toEqual({ modelType: 'openrouter', modelId: 'vendor/model:free' });
  const command = CommandFactory.createCommand({ task: 'Answer', userId: 'user-a', modelType: 'openrouter', modelId: 'vendor/model:free' });
  expect(parseAgentModel(command.model!)).toEqual({ modelType: 'openrouter', modelId: 'vendor/model:free' });
});