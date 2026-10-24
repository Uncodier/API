import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

jest.mock('@/lib/database/supabase-client', () => {
  const forbidden = () => { throw new Error('Database forbidden in offline tests'); };
  return { supabaseAdmin: { from: forbidden, rpc: forbidden }, supabase: { from: forbidden, rpc: forbidden } };
});
jest.mock('@supabase/supabase-js', () => ({ createClient: () => { throw new Error('Database client forbidden'); } }));
jest.mock('openai', () => ({ __esModule: true, default: () => { throw new Error('Real SDK forbidden'); } }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn(), getLatestTelemetry: jest.fn() }));
jest.mock('@/lib/services/ai/openrouter', () => ({
  ...jest.requireActual('@/lib/services/ai/openrouter'), createOpenRouterClient: jest.fn(),
}));
jest.mock('@/lib/services/billing/openrouter-usage-billing', () => ({ chargeOpenRouterUsage: jest.fn() }));
jest.mock('@/lib/services/robot-instance/instance-context-budget', () => ({
  fitInstanceRequest: jest.fn(), resolveModelContextCapacity: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/utils/api-utils', () => ({ handleIncompleteJsonResponse: jest.fn(async value => value) }));
jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: jest.fn(), getAuthenticatedRateIdentity: jest.fn(() => 'offline-principal'),
  isInternalServiceRequest: jest.fn(() => false),
}));

import { NextRequest } from 'next/server';
import { observeCompletedTextRequest } from '../text-execution-observation';
import { getTextObservationKey } from '../handlers/ai/passive-probes';
import { recordTelemetry } from '../telemetry';
import { createOpenRouterClient, getOpenRouterChatModel, OpenRouterConfigurationError } from '@/lib/services/ai/openrouter';
import { requestOpenRouterChat } from '@/lib/services/ai/openrouter-chat-request';
import { createHarnessModel } from '@/lib/harness/__tests__/retired/model';
import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';
import { chargeOpenRouterUsage } from '@/lib/services/billing/openrouter-usage-billing';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';
import { handleIncompleteJsonResponse } from '@/lib/utils/api-utils';
import { POST as aiPost, GET as aiGet } from '@/app/api/ai/route';
import { POST as textPost, GET as textGet } from '@/app/api/ai/text/route';

const telemetry = jest.mocked(recordTelemetry);
const create = jest.fn();
const synthetic = () => randomBytes(24).toString('hex');
const model = 'vendor/offline-model';
const completion = (content = 'Synthetic answer') => ({
  id: 'synthetic-generation', model: 'vendor/routed-model', provider: 'synthetic-provider',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cost: 0.005 },
});
const chunk = (content = 'Synthetic answer', finish_reason: string | null = 'stop') => ({
  id: 'synthetic-generation', model, choices: [{ index: 0, delta: { content }, finish_reason }],
});
function stream(chunks: unknown[]) {
  return (async function* () { for (const value of chunks) yield value; })();
}
const statuses = () => telemetry.mock.calls.map(call => call[1]);
const env = { ...process.env };
let credentials: string[];
let guards: jest.SpyInstance[];
beforeEach(() => {
  jest.clearAllMocks();
  credentials = [synthetic(), synthetic(), synthetic()];
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: credentials[0], OPENROUTER_CHAT_MODEL: model };
  telemetry.mockReset().mockResolvedValue(undefined);
  create.mockReset().mockResolvedValue(completion());
  jest.mocked(createOpenRouterClient).mockImplementation(options => {
    if (!(options?.apiKey ?? process.env.OPENROUTER_API_KEY)) throw new OpenRouterConfigurationError();
    return { chat: { completions: { create } } } as any;
  });
  jest.mocked(chargeOpenRouterUsage).mockReset().mockResolvedValue({} as any);
  jest.mocked(enforceRequestRateLimit).mockReset().mockResolvedValue(null);
  jest.mocked(handleIncompleteJsonResponse).mockReset().mockImplementation(async value => value);
  const forbidden = () => { throw new Error('Network forbidden in offline tests'); };
  guards = [jest.spyOn(globalThis, 'fetch').mockImplementation(forbidden),
    jest.spyOn(net, 'connect').mockImplementation(forbidden), jest.spyOn(tls, 'connect').mockImplementation(forbidden),
    jest.spyOn(http, 'request').mockImplementation(forbidden), jest.spyOn(https, 'request').mockImplementation(forbidden)];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  for (const credential of credentials) expect(JSON.stringify(telemetry.mock.calls)).not.toContain(credential);
  jest.restoreAllMocks();
  process.env = { ...env };
});

describe('existing real request observer', () => {
  it('awaits a fixed receipt without changing response/usage/identity or issuing another request', async () => {
    const result = completion(credentials[1]);
    let release!: () => void;
    telemetry.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const request = jest.fn(async () => result);
    let returned = false;
    const pending = observeCompletedTextRequest(model, request).then(value => { returned = true; return value; });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    expect(returned).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(getTextObservationKey(model), 'up',
      'Text request completed with generated output', expect.any(Number));
    release();
    expect(await pending).toBe(result);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('valid function tools establish generation without text; malformed tools do not', async () => {
    const result = { ...completion(''), choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
      tool_calls: [{ id: 'call-a', type: 'function', function: { name: credentials[1], arguments: credentials[2] } }] } }] };
    expect(await observeCompletedTextRequest(model, async () => result)).toBe(result);
    expect(statuses()).toEqual(['up']);
    telemetry.mockClear();
    const malformed = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'missing-function' }] } }] };
    expect(await observeCompletedTextRequest(model, async () => malformed)).toBe(malformed);
    expect(statuses()).toEqual(['down']);
  });

  it.each([{}, { choices: [] }, { choices: { some: 'malformed' } }, completion('  '), { error: { message: 'Synthetic provider error' } },
    { choices: [{ finish_reason: 'error', message: { content: 'partial' } }] }])('never declares empty or failed output healthy', async result => {
    expect(await observeCompletedTextRequest(model, async () => result)).toBe(result);
    expect(statuses()).toEqual(['down']);
  });

  it('filters and caller request/configuration errors create no outage; SDK failures retain all metadata', async () => {
    await observeCompletedTextRequest(model, async () => ({ choices: [{ finish_reason: 'content_filter', message: { content: 'refused' } }] }));
    for (const error of [new TypeError('invalid input'), new OpenRouterConfigurationError(), { status: 400 }, { status: 404 }, { status: 422 }]) {
      await expect(observeCompletedTextRequest(model, async () => { throw error; })).rejects.toBe(error);
    }
    expect(telemetry).not.toHaveBeenCalled();
    const error = Object.assign(new Error(credentials[1]), { status: 503,
      usage: { cost: 0.01 }, generationId: 'error-generation', headers: { authorization: credentials[2] } });
    telemetry.mockRejectedValueOnce(new Error(credentials[0]));
    await expect(observeCompletedTextRequest(model, async () => { throw error; })).rejects.toBe(error);
    expect(statuses()).toEqual(['down']);
    expect(error.usage).toEqual({ cost: 0.01 });
  });

  it('provider response JSON parse failure is not confused with later caller validation', async () => {
    const error = new SyntaxError('Synthetic invalid provider JSON');
    await expect(observeCompletedTextRequest(model, async () => { throw error; })).rejects.toBe(error);
    expect(statuses()).toEqual(['down']);
  });

  it('foreign credentials are invisible to platform health while matching platform credentials are observed', async () => {
    const result = completion();
    expect(await observeCompletedTextRequest(model, async () => result, { apiKey: credentials[1] })).toBe(result);
    const foreignStream = stream([chunk()]);
    expect(await observeCompletedTextRequest(model, async () => foreignStream, { apiKey: credentials[1] })).toBe(foreignStream);
    expect(telemetry).not.toHaveBeenCalled();
    await observeCompletedTextRequest(model, async () => result, { apiKey: ` ${credentials[0]} ` });
    expect(statuses()).toEqual(['up']);
  });

  it('encloses the full admission retry, not a transient failed first attempt', async () => {
    create.mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(completion());
    await observeCompletedTextRequest(model, () => requestOpenRouterChat({ model, max_tokens: 256 }, create,
      { sleep: async () => {}, random: () => 0 }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(statuses()).toEqual(['up']);
  });

  it('a separately scoped operation never writes the standard text key', async () => {
    await observeCompletedTextRequest(model, async () => completion(), { observationKey: 'ai_text_continuation_synthetic' });
    expect(telemetry.mock.calls[0][0]).toBe('ai_text_continuation_synthetic');
    expect(telemetry.mock.calls[0][0]).not.toBe(getTextObservationKey(model));
  });

  it('keeps SDK controller and private-field methods usable, awaits full consumption including usage-only chunks', async () => {
    const values = [chunk('partial', null), chunk(' answer'), { choices: [], usage: completion().usage }];
    class SDKStream {
      #identity = credentials[1];
      controller = new AbortController();
      method() { return this.#identity; }
      async *[Symbol.asyncIterator]() { for (const value of values) yield value; }
    }
    const original = new SDKStream();
    const observed = await observeCompletedTextRequest(model, async () => original);
    expect(observed.controller).toBe(original.controller);
    expect(observed.method()).toBe(credentials[1]);
    expect(telemetry).not.toHaveBeenCalled();
    const output = [];
    for await (const value of observed) {
      expect(telemetry).not.toHaveBeenCalled();
      output.push(value);
    }
    expect(output).toEqual(values);
    expect(output[2]).toBe(values[2]);
    expect(statuses()).toEqual(['up']);
  });

  it('validates fragmented stream tool identity without storing any fragments', async () => {
    const observed = await observeCompletedTextRequest(model, async () => stream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: credentials[1] } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: credentials[2] } }] }, finish_reason: 'tool_calls' }] },
    ]));
    for await (const _ of observed) { /* Existing consumption only. */ }
    expect(statuses()).toEqual(['up']);
  });

  it('cancelled, early-returned and caller callback-failed streams create neither success nor outage', async () => {
    const aborted = new AbortController(); aborted.abort();
    await expect(observeCompletedTextRequest(model, async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await observeCompletedTextRequest(model, async () => completion(), { signal: aborted.signal });
    const early = await observeCompletedTextRequest(model, async () => stream([chunk(), chunk()]));
    for await (const _ of early) break;
    const callbacks = await observeCompletedTextRequest(model, async () => stream([chunk()]));
    const localError = new Error('Caller callback failed');
    await expect((async () => { for await (const _ of callbacks) throw localError; })()).rejects.toBe(localError);
    const controller = new AbortController();
    const cancelStream = { controller, async *[Symbol.asyncIterator]() { yield chunk(); } };
    const cancelledStream = await observeCompletedTextRequest(model, async () => cancelStream);
    for await (const _ of cancelledStream) cancelledStream.controller.abort();
    expect(telemetry).not.toHaveBeenCalled();
  });

  it('stream provider exceptions and error envelopes are down exactly once, with unchanged chunks/errors', async () => {
    const error = Object.assign(new Error(credentials[1]), { usage: completion().usage, generationId: 'error-generation' });
    const original = (async function* () { yield chunk('partial', null); throw error; })();
    const observed = await observeCompletedTextRequest(model, async () => original);
    await expect((async () => { for await (const _ of observed) { /* consume */ } })()).rejects.toBe(error);
    expect(statuses()).toEqual(['down']);
    telemetry.mockClear();
    const badChunk = { error: { message: credentials[2] } };
    const failed = await observeCompletedTextRequest(model, async () => stream([chunk(), badChunk]));
    const seen = [];
    for await (const value of failed) seen.push(value);
    expect(seen[1]).toBe(badChunk);
    expect(statuses()).toEqual(['down']);
  });

  it.each([stream([]), stream([chunk('  ')]), stream([chunk('partial', null)])])('empty or truncated streams cannot establish success', async original => {
    const observed = await observeCompletedTextRequest(model, async () => original);
    for await (const _ of observed) { /* consume */ }
    expect(statuses()).toEqual(['down']);
  });

  it('SDK automatic controller abort on a provider/parse exception is still a provider failure', async () => {
    const controller = new AbortController();
    const error = new SyntaxError('Synthetic invalid SSE JSON');
    const original = { controller, async *[Symbol.asyncIterator]() {
      try { yield chunk('partial', null); throw error; }
      finally { controller.abort(); }
    } };
    const observed = await observeCompletedTextRequest(model, async () => original);
    await expect((async () => { for await (const _ of observed) { /* consume */ } })()).rejects.toBe(error);
    expect(controller.signal.aborted).toBe(true);
    expect(statuses()).toEqual(['down']);
  });
});

describe('real mainstream caller paths with only provider/persistence doubles', () => {
  const harnessInput = () => ({ system: 'Synthetic instructions', messages: [], tools: [], maxOutputTokens: 256,
    signal: new AbortController().signal });
  const request = (path: string, body: object) => new NextRequest(`https://text.example.test${path}`, {
    method: 'POST', body: JSON.stringify(body),
  });

  it('actual harness retries once without a stale failure and keeps authoritative billing/reasoning evidence', async () => {
    const result = completion();
    (result.choices[0].message as any).reasoning_details = [{ type: 'reasoning.text', text: credentials[1] }];
    create.mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(result);
    const reply = await createHarnessModel().respond(harnessInput());
    expect(create).toHaveBeenCalledTimes(2);
    expect(statuses()).toEqual(['up']);
    expect(reply).toMatchObject({ generationId: result.id, model: result.model, usage: {
      inputTokens: 7, outputTokens: 3, cost: 0.005 }, message: { reasoningDetails: [{ text: credentials[1] }] } });
  });

  it('actual harness validation retains evidence while failing; admission cancellation leaves no receipt', async () => {
    const result = { ...completion(), choices: [] };
    create.mockResolvedValueOnce(result);
    await expect(createHarnessModel().respond(harnessInput())).rejects.toMatchObject({
      generationId: result.id, usage: { cost: 0.005 }, model: result.model });
    expect(statuses()).toEqual(['down']);
    telemetry.mockClear();
    const input = harnessInput();
    const abort = new AbortController(); input.signal = abort.signal;
    create.mockImplementationOnce(async () => { abort.abort(); throw { status: 429 }; });
    await expect(createHarnessModel().respond(input)).rejects.toMatchObject({ admissionRejected: true });
    expect(telemetry).not.toHaveBeenCalled();
  });

  it.each([aiPost, textPost])('actual API POST preserves envelope/id/usage and observes the resolved request model', async post => {
    const result = completion(); create.mockResolvedValueOnce(result);
    const response = await post(request('/api/ai/text', { messages: [{ role: 'user', content: credentials[1] }] }));
    expect(await response.json()).toMatchObject({ id: result.id, provider: result.provider, usage: result.usage, choices: result.choices });
    expect(telemetry.mock.calls[0][0]).toBe(getTextObservationKey(getOpenRouterChatModel()));
    expect(statuses()).toEqual(['up']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('GET, invalid input, rate limiting and missing credentials never run inference or write receipts', async () => {
    await aiGet(); await textGet();
    expect((await aiPost(request('/api/ai', { messages: [] }))).status).toBe(400);
    expect((await textPost(request('/api/ai/text', { messages: [], provider: 'openrouter' }))).status).toBe(400);
    jest.mocked(enforceRequestRateLimit).mockResolvedValueOnce(new Response('', { status: 429 }) as any);
    expect((await textPost(request('/api/ai/text', { messages: [{ role: 'user', content: 'Hello' }] }))).status).toBe(429);
    delete process.env.OPENROUTER_API_KEY;
    expect((await textPost(request('/api/ai/text', { messages: [{ role: 'user', content: 'Hello' }] }))).status).toBe(500);
    expect(create).not.toHaveBeenCalled(); expect(telemetry).not.toHaveBeenCalled();
  });

  it('API postprocessing failure does not turn generated provider output into an outage', async () => {
    jest.mocked(handleIncompleteJsonResponse).mockRejectedValueOnce(new Error('Local validation failure'));
    expect((await aiPost(request('/api/ai', { messages: [{ role: 'user', content: 'Hello' }] }))).status).toBe(500);
    expect(statuses()).toEqual(['up']);
  });

  it.each([aiPost, textPost])('actual API provider failure writes a safe down receipt and keeps the existing HTTP failure', async post => {
    create.mockRejectedValueOnce(Object.assign(new Error(credentials[1]), { status: 503 }));
    const response = await post(request('/api/ai/text', { messages: [{ role: 'user', content: credentials[2] }] }));
    expect(response.status).toBe(500);
    for (const credential of credentials) expect(await response.clone().text()).not.toContain(credential);
    expect(statuses()).toEqual(['down']);
  });

  it('actual executor nonstream retries admission only, bills once, preserves usage and has one success receipt', async () => {
    create.mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(completion());
    const executor = new AIAgentExecutor({ provider: 'openrouter', model, siteId: 'synthetic-site' });
    const result = await executor.act({ tools: [], prompt: 'Synthetic question', maxIterations: 1 });
    expect(result.text).toBe('Synthetic answer'); expect(create).toHaveBeenCalledTimes(2);
    expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ usage: completion().usage,
      generationId: 'synthetic-generation', siteId: 'synthetic-site' }));
    expect(statuses()).toEqual(['up']);
  });

  it('actual executor stream keeps final usage, billing count and callbacks unchanged', async () => {
    create.mockResolvedValueOnce(stream([chunk('Hello', null), chunk(' world'), { choices: [], usage: completion().usage }]));
    const executor = new AIAgentExecutor({ provider: 'openrouter', model, siteId: 'synthetic-site' });
    const onStreamChunk = jest.fn(async () => {});
    const result = await executor.act({ tools: [], prompt: 'Synthetic question', maxIterations: 1, stream: true,
      onStreamStart: async () => 'synthetic-log', onStreamChunk });
    expect(result.text).toBe('Hello world'); expect(create).toHaveBeenCalledTimes(1);
    expect(onStreamChunk).toHaveBeenLastCalledWith('synthetic-log', 'Hello world', true);
    expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ usage: completion().usage,
      generationId: 'synthetic-generation', metadata: { model, context: 'custom-automation' } }));
    expect(statuses()).toEqual(['up']);
  });

  it('actual executor foreign-key generations cannot assert platform health', async () => {
    await new AIAgentExecutor({ provider: 'openrouter', model, apiKey: credentials[1] })
      .act({ tools: [], prompt: 'Synthetic question', maxIterations: 1 });
    expect(create).toHaveBeenCalledTimes(1); expect(telemetry).not.toHaveBeenCalled();
  });

  it('actual executor stream callback failure settles once, never retries, and is not provider failure', async () => {
    create.mockResolvedValueOnce(stream([chunk('Hello', null), chunk(' world')]));
    const executor = new AIAgentExecutor({ provider: 'openrouter', model, siteId: 'synthetic-site' });
    await expect(executor.act({ tools: [], prompt: 'Synthetic question', maxIterations: 1, stream: true,
      onStreamStart: async () => { throw new Error('Local persistence callback failed'); }, onStreamChunk: async () => {} }))
      .rejects.toThrow('Local persistence callback failed');
    expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1); expect(telemetry).not.toHaveBeenCalled();
  });

  it('actual executor billing failure still stops without retry and does not falsify provider outage', async () => {
    jest.mocked(chargeOpenRouterUsage).mockRejectedValueOnce(new Error('Synthetic billing outage'));
    const executor = new AIAgentExecutor({ provider: 'openrouter', model, siteId: 'synthetic-site' });
    await expect(executor.act({ tools: [], prompt: 'Synthetic question', maxIterations: 1 }))
      .rejects.toMatchObject({ name: 'OpenRouterBillingError' });
    expect(create).toHaveBeenCalledTimes(1); expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['up']);
  });
});