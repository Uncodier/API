import { randomBytes } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { AssistantExecutionBoundaryError, type AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/services/billing/openrouter-usage-billing', () => ({ chargeOpenRouterUsage: jest.fn().mockResolvedValue(undefined) }));

const originalEnv = process.env;
beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

const calls = () => ['first', 'second'].map((name, i) => ({
  id: `stable-${i}`, type: 'function', function: { name, arguments: JSON.stringify({ value: i }) },
}));

function provider(message: any, stream = false, finish = 'tool_calls') {
  return stream ? (async function* () {
    yield { choices: [{ delta: { ...message, tool_calls: message.tool_calls?.map((call: any, index: number) => ({ ...call, index })) }, finish_reason: finish }] };
  })() : { choices: [{ message, finish_reason: finish }] };
}

function boundary(events: string[]): AssistantExecutionBoundary {
  return {
    beforeModel: jest.fn(async () => { events.push('beforeModel'); }),
    onModelMessage: jest.fn(async () => { events.push('onModelMessage'); }),
    executeTool: jest.fn(async (call, execute) => {
      events.push(`wrap:${call.id}`);
      const result = await execute();
      events.push(`receipt:${call.id}`);
      return result;
    }),
    afterTurn: jest.fn(async () => { events.push('afterTurn'); }),
  };
}

it.each([false, true])('orders real provider admission, model message, each tool, persistence and turn hook (stream=%s)', async stream => {
  const events: string[] = [];
  const executionBoundary = boundary(events);
  executionBoundary.signal = new AbortController().signal;
  const executor = new AIAgentExecutor();
  const message = { role: 'assistant', content: '', tool_calls: calls() };
  const create = jest.fn(async () => { events.push('provider'); return provider(message); });
  (executor as any).client.chat.completions.create = create;
  const tools = ['first', 'second'].map(name => ({ name, execute: jest.fn(async () => {
    events.push(`execute:${name}`); return { success: true };
  }) }));
  const onStreamStart = jest.fn(async () => 'stream-log');
  const onStreamChunk = jest.fn(async () => {});
  const result = await executor.act({ system: 'Host instructions', prompt: 'Run', tools, maxIterations: 1,
    maxOutputTokens: 1234, executionBoundary, stream,
    onStreamStart, onStreamChunk,
    onStep: async () => { events.push('onStep'); },
  });
  expect(events).toEqual(['beforeModel', 'provider', 'onModelMessage', 'wrap:stable-0', 'execute:first',
    'receipt:stable-0', 'wrap:stable-1', 'execute:second', 'receipt:stable-1', 'onStep', 'afterTurn']);
  expect(executionBoundary.beforeModel).toHaveBeenCalledWith({ system: 'Host instructions',
    messages: expect.any(Array), tools: expect.arrayContaining([expect.objectContaining({ type: 'function' })]), maxOutputTokens: 1234 });
  expect((create.mock.calls as any)[0][1]).toEqual({ signal: executionBoundary.signal });
  expect(executionBoundary.executeTool).toHaveBeenNthCalledWith(1, { id: 'stable-0', name: 'first', args: { value: 0 } }, expect.any(Function));
  expect(executionBoundary.executeTool).toHaveBeenNthCalledWith(2, { id: 'stable-1', name: 'second', args: { value: 1 } }, expect.any(Function));
  expect(executionBoundary.afterTurn).toHaveBeenCalledWith(result.messages);
  expect(result.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['stable-0', 'stable-1']);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(onStreamStart).not.toHaveBeenCalled();
  expect(onStreamChunk).not.toHaveBeenCalled();
});

it.each(['beforeModel', 'onModelMessage', 'executeTool', 'afterTurn'] as const)('makes %s rejection fatal, without another request or fabricated receipt', async hook => {
  const executionBoundary = boundary([]);
  let transcript: any[] = [];
  executionBoundary.beforeModel = jest.fn(async input => { transcript = input.messages; });
  const sensitive = randomBytes(24).toString('hex');
  executionBoundary[hook] = jest.fn().mockRejectedValue(Object.assign(new Error(`socket timeout content management policy ${sensitive}`),
    { status: 503, code: 'content_filter' }));
  const executor = new AIAgentExecutor({ siteId: 'test-site' });
  const create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: calls() }));
  (executor as any).client.chat.completions.create = create;
  const tools = ['first', 'second'].map(name => ({ name, execute: jest.fn().mockResolvedValue({ success: true }) }));
  const onStep = jest.fn();
  const failure = await executor.act({ prompt: 'Run', tools, executionBoundary, onStep, maxIterations: 3 }).catch(error => error);
  expect(failure).toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(failure.name).toBe('RecoveryError');
  expect(create).toHaveBeenCalledTimes(hook === 'beforeModel' ? 0 : 1);
  expect(tools[1].execute).toHaveBeenCalledTimes(hook === 'afterTurn' ? 1 : 0);
  expect(onStep).toHaveBeenCalledTimes(hook === 'afterTurn' ? 1 : 0);
  expect(transcript.filter(m => m.role === 'tool')).toHaveLength(hook === 'afterTurn' ? 2 : 0);
  const logs = JSON.stringify([jest.mocked(console.log).mock.calls, jest.mocked(console.warn).mock.calls, jest.mocked(console.error).mock.calls]);
  expect(logs).not.toContain(sensitive);
  expect(failure.message).not.toContain(sensitive);
});

it('preserves the exact host timeout from the completed turn hook without another request', async () => {
  const executionBoundary = boundary([]);
  const controller = new AbortController();
  executionBoundary.signal = controller.signal;
  const timeout = new DOMException('Offline host deadline', 'TimeoutError');
  executionBoundary.afterTurn = async () => { controller.abort(timeout); throw timeout; };
  const executor = new AIAgentExecutor();
  const create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: 'Saved response' }, false, 'stop'));
  (executor as any).client.chat.completions.create = create;
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary, maxIterations: 3 })).rejects.toBe(timeout);
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(['tool failure', 'receipt failure'])('never retries an effect or runs remaining tools after %s', async failurePoint => {
  const executionBoundary = boundary([]);
  let transcript: any[] = [];
  executionBoundary.beforeModel = async input => { transcript = input.messages; };
  const effect = jest.fn(async () => {
    if (failurePoint === 'tool failure') throw new Error('socket timeout');
    return { success: true };
  });
  executionBoundary.executeTool = async (_call, execute) => {
    await execute();
    throw new Error('socket timeout saving receipt');
  };
  const forbidden = jest.fn();
  const executor = new AIAgentExecutor();
  const create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: calls() }));
  (executor as any).client.chat.completions.create = create;
  await expect(executor.act({ prompt: 'Run', tools: [{ name: 'first', execute: effect }, { name: 'second', execute: forbidden }],
    executionBoundary, maxIterations: 3 })).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(effect).toHaveBeenCalledTimes(1);
  expect(forbidden).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  expect(transcript.some(m => m.role === 'tool')).toBe(false);
  expect(executionBoundary.afterTurn).not.toHaveBeenCalled();
});

it.each([false, true])('persists no-tool and length turns before afterTurn (length=%s)', async length => {
  const events: string[] = [];
  const executionBoundary = boundary(events);
  executionBoundary.onModelMessage = jest.fn(async message => {
    expect(message.tool_calls).toBeUndefined();
    events.push('onModelMessage');
  });
  const executor = new AIAgentExecutor();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: 'Text',
    ...(length ? { tool_calls: calls() } : {}) }, false, length ? 'length' : 'stop'));
  const result = await executor.act({ prompt: 'Run', tools: [], executionBoundary,
    onStep: async () => { events.push('onStep'); } });
  expect(events).toEqual(['beforeModel', 'onModelMessage', 'onStep', 'afterTurn']);
  expect(result.steps).toHaveLength(1);
  expect(executionBoundary.executeTool).not.toHaveBeenCalled();
});

it('passes overridden arguments through the wrapper without logging their values, and allows only one effect', async () => {
  const executionBoundary = boundary([]);
  const sensitive = randomBytes(24).toString('hex');
  const override = randomBytes(24).toString('hex');
  executionBoundary.executeTool = jest.fn(async (_call, execute) => {
    const [first, second] = await Promise.all([execute(), execute()]);
    expect(second).toBe(first);
    return first;
  });
  const execute = jest.fn().mockResolvedValue({ success: true });
  const executor = new AIAgentExecutor();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: [{
    id: 'override-call', type: 'function', function: { name: 'tools', arguments: JSON.stringify({ action: 'call', name: 'target', args: { sensitive } }) },
  }] }));
  await executor.act({ prompt: 'Run', tools: [{ name: 'tools', execute }], executionBoundary, maxIterations: 1,
    toolOverrides: { target: { override } } });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(jest.mocked(executionBoundary.executeTool).mock.calls[0][0].args.args)).toEqual({ sensitive, override });
  const logs = JSON.stringify([jest.mocked(console.log).mock.calls, jest.mocked(console.warn).mock.calls, jest.mocked(console.error).mock.calls]);
  expect(logs).not.toContain(sensitive);
  expect(logs).not.toContain(override);
});

it('does not bypass the wrapper for computer.wait', async () => {
  const executionBoundary = boundary([]);
  const executor = new AIAgentExecutor();
  const execute = jest.fn().mockResolvedValue({ success: true });
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: [{
    id: 'wait-call', type: 'function', function: { name: 'computer', arguments: '{"action":"wait"}' },
  }] }));
  await executor.act({ prompt: 'Wait', tools: [{ name: 'computer', execute }], executionBoundary, maxIterations: 1 });
  expect(execute).toHaveBeenCalledWith({ action: 'wait' });
  expect(executionBoundary.executeTool).toHaveBeenCalledTimes(1);
});

it('rejects an already-aborted host signal before provider I/O', async () => {
  const executionBoundary = boundary([]);
  const controller = new AbortController();
  controller.abort();
  executionBoundary.signal = controller.signal;
  const executor = new AIAgentExecutor();
  const create = jest.fn();
  (executor as any).client.chat.completions.create = create;
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary })).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(create).not.toHaveBeenCalled();
});

it('runs beforeModel for each actual admission attempt with its effective output limit', async () => {
  const events: string[] = [];
  const executionBoundary = boundary(events);
  const executor = new AIAgentExecutor();
  const create = jest.fn().mockImplementationOnce(async () => {
    events.push('provider');
    throw Object.assign(new Error('can only afford 1000'), { status: 402 });
  }).mockImplementationOnce(async () => {
    events.push('provider');
    return provider({ role: 'assistant', content: 'Done' }, false, 'stop');
  });
  (executor as any).client.chat.completions.create = create;
  await executor.act({ prompt: 'Run', tools: [], executionBoundary, maxOutputTokens: 2000 });
  expect(events).toEqual(['beforeModel', 'provider', 'beforeModel', 'provider', 'onModelMessage', 'afterTurn']);
  expect(jest.mocked(executionBoundary.beforeModel).mock.calls.map(([input]) => input.maxOutputTokens)).toEqual([2000, 900]);
});

it('validates a rejected provider envelope before calling onModelMessage', async () => {
  const executionBoundary = boundary([]);
  const executor = new AIAgentExecutor();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue({ error: { message: 'Rejected' }, choices: [] });
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary })).rejects.toThrow();
  expect(executionBoundary.onModelMessage).not.toHaveBeenCalled();
  expect(executionBoundary.executeTool).not.toHaveBeenCalled();
  expect(executionBoundary.afterTurn).not.toHaveBeenCalled();
});

it('checkpoints finalized canonical coercion and overrides before intent execution', async () => {
  const executionBoundary = boundary([]);
  const approved = new Map<string, any>();
  executionBoundary.onModelMessage = jest.fn(async message => {
    for (const call of message.tool_calls) approved.set(call.id, JSON.parse(call.function.arguments));
  });
  executionBoundary.executeTool = jest.fn(async (call, execute) => {
    expect(call.args).toEqual(approved.get(call.id));
    return execute();
  });
  const nested = jest.fn(async args => {
    expect(args).toEqual(approved.get('coerced'));
    return { success: true };
  });
  const router = jest.fn(async args => {
    expect(args).toEqual(approved.get('overridden'));
    return { success: true };
  });
  const executor = new AIAgentExecutor();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: [
    { id: 'coerced', type: 'function', function: { name: 'nested', arguments: JSON.stringify({ payload: '{"count":7}', items: '[{"count":8}]' }) } },
    { id: 'overridden', type: 'function', function: { name: 'tools', arguments: JSON.stringify({ action: 'call', name: 'target', args: '{"count":"1"}' }) } },
  ] }));
  const result = await executor.act({ prompt: 'Run', executionBoundary, maxIterations: 1,
    toolOverrides: { target: { count: 9 } }, tools: [
      { name: 'nested', parameters: { type: 'object', properties: {
        payload: { type: 'object', properties: { count: { type: 'number' } } },
        items: { type: 'array', items: { type: 'object', properties: { count: { type: 'number' } } } },
      } }, execute: nested }, { name: 'tools', execute: router },
    ] });
  expect(approved.get('coerced')).toEqual({ payload: { count: 7 }, items: [{ count: 8 }] });
  expect(JSON.parse(approved.get('overridden').args)).toEqual({ count: 9 });
  expect(executionBoundary.onModelMessage).toHaveBeenCalledTimes(1);
  expect(result.steps[0].toolCalls?.map(call => call.args)).toEqual([...approved.values()]);
  expect(nested).toHaveBeenCalledTimes(1);
  expect(router).toHaveBeenCalledTimes(1);
});

it('records boundary receipts for unknown, invalid and single-turn skipped provider calls in order', async () => {
  const executionBoundary = boundary([]);
  const approved = new Map<string, any>();
  const receipts: any[] = [];
  executionBoundary.onModelMessage = jest.fn(async message => {
    for (const call of message.tool_calls) approved.set(call.id, JSON.parse(call.function.arguments));
  });
  executionBoundary.executeTool = jest.fn(async (call, execute) => {
    expect(call.args).toEqual(approved.get(call.id));
    const result = await execute();
    receipts.push({ id: call.id, result });
    return result;
  });
  const execute = jest.fn().mockResolvedValue({ success: true });
  const executor = new AIAgentExecutor();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: [
    { id: 'unknown', type: 'function', function: { name: 'missing', arguments: '{}' } },
    { id: 'invalid', type: 'function', function: { name: 'known', arguments: 'not json' } },
    { id: 'effect', type: 'function', function: { name: 'known', arguments: '{}' } },
    { id: 'skipped', type: 'function', function: { name: 'known', arguments: '{}' } },
  ] }));
  const onStep = jest.fn();
  const result = await executor.act({ prompt: 'Run', executionBoundary, enforceSingleTurn: true,
    tools: [{ name: 'known', execute }], onStep });
  expect(receipts).toEqual([
    { id: 'unknown', result: { success: false, executed: false, error: 'tool_not_found' } },
    { id: 'invalid', result: { success: false, executed: false, error: 'invalid_tool_arguments' } },
    { id: 'effect', result: { success: true } },
    { id: 'skipped', result: { success: false, executed: false, status: 'skipped', error: 'single_turn_tool_limit' } },
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual([...approved.keys()]);
  expect(result.steps[0].toolResults).toHaveLength(4);
  expect(executionBoundary.onModelMessage).toHaveBeenCalledTimes(1);
  expect(onStep).toHaveBeenCalledTimes(1);
  expect(executionBoundary.afterTurn).toHaveBeenCalledTimes(1);
});

it('stops remaining effects when a synthetic boundary receipt rejects', async () => {
  const executionBoundary = boundary([]);
  let transcript: any[] = [];
  executionBoundary.beforeModel = async input => { transcript = input.messages; };
  executionBoundary.executeTool = jest.fn(async (_call, execute) => { await execute(); throw new Error('Receipt unavailable'); });
  const executor = new AIAgentExecutor();
  const execute = jest.fn();
  (executor as any).client.chat.completions.create = jest.fn().mockResolvedValue(provider({ role: 'assistant', content: '', tool_calls: [
    { id: 'unknown', type: 'function', function: { name: 'missing', arguments: '{}' } },
    { id: 'effect', type: 'function', function: { name: 'known', arguments: '{}' } },
  ] }));
  await expect(executor.act({ prompt: 'Run', tools: [{ name: 'known', execute }], executionBoundary })).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(execute).not.toHaveBeenCalled();
  expect(transcript.some(message => message.role === 'tool')).toBe(false);
  expect(executionBoundary.afterTurn).not.toHaveBeenCalled();
});