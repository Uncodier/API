import { randomBytes } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';

const originalEnv = process.env;
beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline test attempted network access'));
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

it('uses the fixed OpenRouter transport and ignores old environment routing/defaults', () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_MODEL = 'legacy-model';
  process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
  const executor = new AIAgentExecutor({ provider: 'azure', baseURL: 'https://example.invalid' });
  expect(executor.getProvider()).toBe('openrouter');
  expect(executor.getModel()).toBe('openai/gpt-6.1-sol');
  expect((executor as any).client.baseURL).toBe('https://openrouter.ai/api/v1');
  expect((executor as any).client.apiKey).toBe(process.env.OPENROUTER_API_KEY);
  expect((executor as any).client.maxRetries).toBe(0);
});

it('fails closed when only legacy credentials are configured', () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_API_KEY = randomBytes(24).toString('hex');
  expect(() => new AIAgentExecutor({ provider: 'openai' })).toThrow('OPENROUTER_API_KEY');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('rejects provider-specific credentials and private Azure deployments before network I/O', () => {
  for (const provider of ['azure', 'gemini', 'openai', 'xai'] as const) {
    expect(() => new AIAgentExecutor({ provider, apiKey: randomBytes(24).toString('hex') })).toThrow('Legacy provider credentials');
  }
  expect(() => new AIAgentExecutor({ provider: 'azure', deployment: 'private-deployment' })).toThrow('OpenRouter catalog model ID');
  expect(() => new AIAgentExecutor({ provider: 'azure', model: 'private-deployment' })).toThrow('OpenRouter catalog model ID');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('normalizes model overrides, omits unsupported sampling and retains cost metadata', async () => {
  const executor = new AIAgentExecutor({ siteId: 'site-test' });
  const create = jest.fn().mockResolvedValue({ id: 'generation-test', model: 'openai/gpt-6.1-sol', choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.005, cost_details: { upstream_inference_cost: 0.004 }, is_byok: false } });
  (executor as any).client.chat.completions.create = create;
  const result = await executor.act({ model: 'gpt-6.1-sol', prompt: 'Run', tools: [], temperature: 0.3, maxIterations: 1 });
  expect(create.mock.calls[0][0]).toMatchObject({ model: 'openai/gpt-6.1-sol', user: 'site-test', reasoning: { effort: 'low' } });
  expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  expect(create.mock.calls[0][0]).not.toHaveProperty('parallel_tool_calls');
  expect(result.usage.cost).toBe(0.005);
  expect(result.steps[0]).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-6.1-sol', generationId: 'generation-test' });
  expect(result.steps[0].usage).toMatchObject({ cost: 0.005, cost_details: { upstream_inference_cost: 0.004 }, is_byok: false });
});

it.each(['gpt-5.6', 'openai/gpt-5.6-sol'])('migrates executor configuration and turn override %s', async model => {
  const executor = new AIAgentExecutor({ model });
  expect(executor.getModel()).toBe('openai/gpt-6.1-sol');
  const create = jest.fn().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] });
  (executor as any).client.chat.completions.create = create;
  const result = await executor.act({ model, prompt: 'Run', tools: [], temperature: 0.3, maxIterations: 1 });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0].model).toBe('openai/gpt-6.1-sol');
  expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  expect(result.steps[0].model).toBe('openai/gpt-6.1-sol');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('replays streamed reasoning and tool results on the same model/account and counts final usage once', async () => {
  const executor = new AIAgentExecutor({ siteId: 'site-test' });
  const requests: any[] = [];
  const reasoning = { type: 'reasoning.encrypted', id: 'reasoning-a', index: 0, format: 'openai-responses-v1', data: 'opaque-state' };
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.01 };
  const first = (async function* () {
    yield { id: 'gen-stream-first', model: 'openai/gpt-6.1-sol', choices: [{ delta: { reasoning_details: [{ ...reasoning, data: 'opaque-' }] } }] };
    yield { choices: [{ delta: { reasoning_details: [{ ...reasoning, data: 'state' }], tool_calls: [
      { index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }], usage };
    yield { choices: [], usage };
  })();
  const second = (async function* () {
    yield { id: 'gen-stream-second', model: 'openai/gpt-6.1-sol', choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] };
    yield { choices: [], usage: { ...usage, cost: 0.02 } };
  })();
  const create = jest.fn().mockImplementation(async request => {
    requests.push(JSON.parse(JSON.stringify(request)));
    return requests.length === 1 ? first : second;
  });
  (executor as any).client.chat.completions.create = create;
  const execute = jest.fn().mockResolvedValue({ success: true, result: 'Found' });
  const result = await executor.act({ prompt: 'Look it up', tools: [{ name: 'lookup', execute }], stream: true,
    onStreamStart: async () => 'log', onStreamChunk: async () => {}, maxIterations: 2 });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request).toMatchObject({ model: 'openai/gpt-6.1-sol', user: 'site-test', stream_options: { include_usage: true } });
  expect(requests[1].messages.find((message: any) => message.tool_calls)).toMatchObject({ reasoning_details: [reasoning] });
  expect(requests[1].messages.find((message: any) => message.role === 'tool')).toMatchObject({ tool_call_id: 'call-a' });
  expect(result.usage).toMatchObject({ totalTokens: 60, cost: 0.03 });
  expect(result.steps.map(step => step.generationId)).toEqual(['gen-stream-first', 'gen-stream-second']);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([0, undefined])('retains known zero aggregate cost and leaves absent cost unknown: %s', async cost => {
  const executor = new AIAgentExecutor();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue({
    choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, ...(cost === undefined ? {} : { cost }) },
  });
  const result = await executor.act({ prompt: 'Run', tools: [], maxIterations: 1 });
  if (cost === undefined) expect(result.usage).not.toHaveProperty('cost');
  else expect(result.usage.cost).toBe(0);
});

it('does not submit another generation after an interrupted stream', async () => {
  const executor = new AIAgentExecutor();
  const interrupted = new Error('Stream interrupted');
  const create = jest.fn().mockResolvedValue((async function* () {
    yield { id: 'generation-partial', choices: [{ delta: { content: 'Partial' } }] };
    throw interrupted;
  })());
  (executor as any).client.chat.completions.create = create;
  await expect(executor.act({ prompt: 'Run', tools: [], stream: true,
    onStreamStart: async () => 'log', onStreamChunk: async () => {},
  })).rejects.toBe(interrupted);
  expect(create).toHaveBeenCalledTimes(1);
});

it.each([false, true])('omits aggregate cost when any completion cost is unknown (missingFirst=%s)', async missingFirst => {
  const executor = new AIAgentExecutor();
  const known = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0 };
  const unknown = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
  const create = jest.fn()
    .mockResolvedValueOnce({ id: 'gen-first', usage: missingFirst ? unknown : known, choices: [{ message: { role: 'assistant',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
    .mockResolvedValueOnce({ id: 'gen-second', usage: missingFirst ? known : undefined,
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] });
  (executor as any).client.chat.completions.create = create;
  const result = await executor.act({ prompt: 'Look up', tools: [{ name: 'lookup', execute: jest.fn().mockResolvedValue({ success: true }) }], maxIterations: 2 });
  expect(result.usage).not.toHaveProperty('cost');
  expect(result.steps[missingFirst ? 1 : 0].usage?.cost).toBe(0);
  expect(create).toHaveBeenCalledTimes(2);
});

it.each([false, true])('does not log provider error bodies or echoed credentials (stream=%s)', async (stream) => {
  const executor = new AIAgentExecutor();
  const echoed = randomBytes(24).toString('hex');
  const error = Object.assign(new Error(`Rejected ${process.env.OPENROUTER_API_KEY} ${echoed}`), {
    status: 401, error: { message: echoed }, headers: { 'x-debug-api-key': echoed },
  });
  (executor as any).client.chat.completions.create = jest.fn().mockRejectedValue(error);
  await expect(executor.act({ prompt: 'Run', tools: [], stream,
    onStreamStart: async () => 'log', onStreamChunk: async () => {},
  })).rejects.toBe(error);
  const logs = JSON.stringify(jest.mocked(console.error).mock.calls);
  expect(logs).not.toContain(echoed);
  expect(logs).not.toContain(process.env.OPENROUTER_API_KEY!);
});

it.each([false, true])('retries request admission then executes one tool exactly once (stream=%s)', async streaming => {
  const executor = new AIAgentExecutor();
  const tool = { name: 'lookup', execute: jest.fn().mockResolvedValue({ success: true }) };
  const toolCall = { id: 'retry-call', type: 'function', function: { name: 'lookup', arguments: '{}' } };
  const accepted = streaming ? (async function* () {
    yield { choices: [{ delta: { tool_calls: [{ ...toolCall, index: 0 }] }, finish_reason: 'tool_calls' }] };
  })() : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] };
  const create = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Temporary rejection'), { status: 503 }))
    .mockResolvedValue(accepted);
  (executor as any).client.chat.completions.create = create;
  const onStep = jest.fn();
  const result = await executor.act({ prompt: 'Run', tools: [tool], enforceSingleTurn: true,
    stream: streaming, onStreamStart: async () => 'log', onStreamChunk: async () => {}, onStep });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0].max_tokens).toBe(4096);
  expect(tool.execute).toHaveBeenCalledTimes(1);
  expect(onStep).toHaveBeenCalledTimes(1);
  expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(1);
});

it.each([false, true])('retries affordability with less output without changing the model (stream=%s)', async streaming => {
  const executor = new AIAgentExecutor();
  const accepted = streaming ? (async function* () {
    yield { choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] };
  })() : { choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] };
  const create = jest.fn().mockRejectedValueOnce(Object.assign(new Error('can only afford 3936'), { status: 402 }))
    .mockResolvedValue(accepted);
  (executor as any).client.chat.completions.create = create;
  await executor.act({ prompt: 'Run', tools: [], enforceSingleTurn: true,
    stream: streaming, onStreamStart: async () => 'log', onStreamChunk: async () => {} });
  expect(create.mock.calls.map(([payload]) => payload.max_tokens)).toEqual([4096, 3542]);
  expect(create.mock.calls[1][0].model).toBe('openai/gpt-6.1-sol');
});

it.each([false, true])('never executes truncated tool arguments after hitting the output cap (stream=%s)', async streaming => {
  const executor = new AIAgentExecutor();
  const tool = { name: 'write', execute: jest.fn() };
  const toolCall = { id: 'truncated-call', type: 'function', function: { name: 'write', arguments: '{"value":' } };
  const accepted = streaming ? (async function* () {
    yield { choices: [{ delta: { content: 'Partial', tool_calls: [{ ...toolCall, index: 0 }] }, finish_reason: 'length' }] };
  })() : { choices: [{ message: { role: 'assistant', content: 'Partial', tool_calls: [toolCall] }, finish_reason: 'length' }] };
  const create = jest.fn().mockResolvedValue(accepted);
  (executor as any).client.chat.completions.create = create;
  const result = await executor.act({ prompt: 'Run', tools: [tool],
    stream: streaming, onStreamStart: async () => 'log', onStreamChunk: async () => {} });
  expect(tool.execute).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  expect(result.steps[0].finishReason).toBe('length');
  expect(result.messages.at(-1)).not.toHaveProperty('tool_calls');
});

it('rejects a mid-stream error envelope without executing tools or creating another generation', async () => {
  const executor = new AIAgentExecutor();
  const tool = { name: 'write', execute: jest.fn() };
  const create = jest.fn().mockResolvedValue((async function* () {
    yield { error: { code: 503, message: 'Synthetic SSE error' }, choices: [{ finish_reason: 'error' }] };
  })());
  (executor as any).client.chat.completions.create = create;
  await expect(executor.act({ prompt: 'Run', tools: [tool], stream: true,
    onStreamStart: async () => 'log', onStreamChunk: async () => {} })).rejects.toThrow('after acceptance');
  expect(create).toHaveBeenCalledTimes(1);
  expect(tool.execute).not.toHaveBeenCalled();
});