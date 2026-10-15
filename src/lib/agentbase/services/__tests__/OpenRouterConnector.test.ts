import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import { OpenRouterConnector, PortkeyConnector } from '../PortkeyConnector';
import { parseAgentModel } from '../../models/model-selection';
import { CommandFactory } from '../command/CommandFactory';
import { chargeOpenRouterUsage } from '@/lib/services/billing/openrouter-usage-billing';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/services/billing/openrouter-usage-billing', () => ({ chargeOpenRouterUsage: jest.fn() }));

const create = jest.fn();
const originalEnv = process.env;
const messages = [{ role: 'system' as const, content: 'Support agent instructions.' }, { role: 'user' as const, content: 'Hello' }];
const completion = { choices: [{ message: { content: 'Answer' } }], usage: {
  prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.000123,
  cost_details: { upstream_inference_cost: 0.00012 }, is_byok: false,
} };

beforeEach(() => {
  jest.mocked(chargeOpenRouterUsage).mockReset().mockResolvedValue(undefined);
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

it('returns unchanged streaming chunks and settles usage before stream completion', async () => {
  const stream = (async function* () { yield { choices: [], usage: completion.usage }; })();
  create.mockResolvedValue(stream);
  const result = await new OpenRouterConnector().callAgent(messages, { stream: true, siteId: 'site-a' });
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  expect(chunks).toEqual([{ choices: [], usage: completion.usage }]);
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site-a', usage: completion.usage,
    eventId: expect.stringMatching(/^[a-f0-9-]{36}$/) }));
  expect(result.isStream).toBe(true);
  expect(create.mock.calls[0][0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, user: 'site-a' });
});

it('does not charge no-site completions or wrap no-site streams', async () => {
  await new OpenRouterConnector().callAgent(messages);
  const stream = (async function* () { yield { choices: [], usage: completion.usage }; })();
  create.mockResolvedValue(stream);
  expect((await new OpenRouterConnector().callAgent(messages, { stream: true })).stream).toBe(stream);
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it.each([[], undefined])('charges accepted empty/malformed choices %j before normalization', async choices => {
  create.mockResolvedValue({ id: 'generation-empty', usage: completion.usage, choices });
  await new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' });
  expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'generation-empty', usage: completion.usage }));
});

it('charges accepted error envelopes even though parsing fails', async () => {
  create.mockResolvedValue({ id: 'generation-error', usage: completion.usage, error: { message: 'Malformed result', code: 503 } });
  await expect(new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' })).rejects.toThrow('Malformed result');
  expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
});

it.each([undefined, { prompt_tokens: 1000000 }])('stops on unpriced accepted usage %j without token fallback', async usage => {
  create.mockResolvedValue({ choices: [], usage });
  jest.mocked(chargeOpenRouterUsage).mockRejectedValue(new Error('billing requires reconciliation'));
  await expect(new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' })).rejects.toThrow('reconciliation');
  expect(create).toHaveBeenCalledTimes(1);
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ usage }));
});

it('uses distinct host event IDs per request when generation IDs are absent', async () => {
  await new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' });
  await new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' });
  const ids = jest.mocked(chargeOpenRouterUsage).mock.calls.map(([input]) => input.eventId);
  expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
  expect(ids[1]).not.toBe(ids[0]);
});

it('persists unknown transport outcomes but not confirmed admission rejections', async () => {
  const connector = new OpenRouterConnector();
  create.mockRejectedValueOnce(Object.assign(new Error('Rejected'), { status: 400 }));
  await expect(connector.callAgent(messages, { siteId: 'site-a' })).rejects.toThrow('Rejected');
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
  create.mockRejectedValueOnce(new Error('Connection reset'));
  jest.mocked(chargeOpenRouterUsage).mockRejectedValueOnce(new Error('billing requires reconciliation'));
  await expect(connector.callAgent(messages, { siteId: 'site-a' })).rejects.toThrow('reconciliation');
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ usage: undefined }));
  expect(create).toHaveBeenCalledTimes(2);
});

it('settles usage carried by a failing SSE chunk before surfacing its error', async () => {
  create.mockResolvedValue((async function* () {
    yield { id: 'generation-sse', usage: completion.usage, error: { code: 503, message: 'Stream failed' } };
  })());
  const result = await new OpenRouterConnector().callAgent(messages, { siteId: 'site-a', stream: true });
  await expect((async () => { for await (const _chunk of result.stream) { /* consume */ } })()).rejects.toThrow('Stream failed');
  expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'generation-sse', usage: completion.usage }));
});

it('rejects stream completion on uncertain billing without dispatching again', async () => {
  create.mockResolvedValue((async function* () {
    yield { id: 'generation-stream', choices: [{ delta: { content: 'Answer' } }] };
  })());
  jest.mocked(chargeOpenRouterUsage).mockRejectedValueOnce(new Error('billing requires reconciliation'));
  const result = await new OpenRouterConnector().callAgent(messages, { siteId: 'site-a', stream: true });
  await expect((async () => { for await (const _chunk of result.stream) { /* consume */ } })()).rejects.toThrow('reconciliation');
  expect(create).toHaveBeenCalledTimes(1);
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'generation-stream', usage: undefined }));
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