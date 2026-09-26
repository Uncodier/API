import { jest } from '@jest/globals';
import * as zod from 'zod';
import * as jsonSchema from 'zod-to-json-schema';
import * as azureVision from '../azure-vision-message-sanitize';
import * as geminiMessages from '../gemini-message-sanitize';
import * as toolArguments from '../coerce-tool-args';
import * as toolResults from '@/lib/services/tool-operation-result';
import type { AIProvider, ActOptions, Message } from '../ai-agent-executor';
import { loadRuntimeModule } from '../test-helpers/load-runtime-module';

class OfflineOpenAI {
  chat = { completions: { create: () => { throw new Error('Provider I/O must be mocked'); } } };
}

const { AIAgentExecutor } = loadRuntimeModule<typeof import('../ai-agent-executor')>(
  'src/lib/custom-automation/ai-agent-executor.ts', {
    openai: OfflineOpenAI,
    'google-auth-library': { GoogleAuth: class {} },
    zod,
    'zod-to-json-schema': jsonSchema,
    './azure-vision-message-sanitize': azureVision,
    './gemini-message-sanitize': geminiMessages,
    './coerce-tool-args': toolArguments,
    '@/lib/services/tool-operation-result': toolResults,
    '@/lib/services/robot-instance/instance-context-budget': {
      fitInstanceRequest: () => { throw new Error('Unexpected context I/O'); },
      resolveModelContextCapacity: () => { throw new Error('Unexpected context I/O'); },
    },
  },
);

const call = (id: string, name = 'write', args = '{}') => ({
  id, type: 'function' as const, function: { name, arguments: args },
});
const completion = (calls: ReturnType<typeof call>[]) => ({
  choices: [{ message: { role: 'assistant', content: '', tool_calls: calls }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});
function stream(calls: ReturnType<typeof call>[]) {
  return (async function* () {
    yield { choices: [{ delta: { tool_calls: calls.map((value, index) => ({ ...value, index })) }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
  })();
}
function executor(provider: AIProvider = 'openai') {
  return new AIAgentExecutor({ provider, apiKey: 'test-key', model: 'test-model',
    baseURL: 'http://localhost/never-called', endpoint: 'http://localhost/never-called', deployment: 'test-model' });
}
function toolResponses(messages: Message[], ids: string[]) {
  const assistantIndex = messages.findIndex(message => message.role === 'assistant' && message.tool_calls?.length);
  const responses = messages.slice(assistantIndex + 1, assistantIndex + 1 + ids.length);
  expect(responses.every(message => message.role === 'tool')).toBe(true);
  expect(responses.map(message => message.tool_call_id).sort()).toEqual([...ids].sort());
  return responses;
}

describe('enforceSingleTurn is an actual execution boundary', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each((['openai', 'azure', 'gemini', 'xai'] as AIProvider[])
    .flatMap(provider => [false, true].map(streaming => ({ provider, streaming }))))(
    'executes one call and answers all IDs with $provider (stream=$streaming)', async ({ provider, streaming }) => {
      const agent = executor(provider);
      const calls = [call('first'), call('second'), call('third')];
      const create = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(streaming ? stream(calls) : completion(calls));
      (agent as any).client.chat.completions.create = create;
      const execute = jest.fn<() => Promise<any>>().mockResolvedValue({ success: true });
      const onStep = jest.fn<NonNullable<ActOptions['onStep']>>();
      const onContextUsage = jest.fn<NonNullable<ActOptions['onContextUsage']>>().mockResolvedValue(undefined);
      const result = await agent.act({ tools: [{ name: 'write', execute }], prompt: 'Do one action',
        enforceSingleTurn: true, maxIterations: 4, stream: streaming,
        onStreamStart: async () => 'log-id', onStreamChunk: async () => {}, onStep, onContextUsage });

      expect(create).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      const request = create.mock.calls[0][0];
      if (provider === 'openai' || provider === 'azure') {
        expect(request.parallel_tool_calls).toBe(false);
        if (streaming) expect(request.stream_options).toEqual({ include_usage: true });
      } else {
        expect(request).not.toHaveProperty('parallel_tool_calls');
        expect(request).not.toHaveProperty('stream_options');
      }
      const responses = toolResponses(result.messages, ['first', 'second', 'third']);
      for (const response of responses.slice(1)) {
        expect(JSON.parse(response.content as string)).toMatchObject({
          success: false, status: 'skipped', executed: false, error: 'single_turn_tool_limit',
        });
      }
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].toolResults?.slice(1).every(value => value.isError)).toBe(true);
      expect(onStep).toHaveBeenCalledTimes(1);
      // Preserve the user's streaming-usage repair: duplicate usage chunks count once.
      expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
      expect(onContextUsage).toHaveBeenCalledTimes(2);
    },
  );

  it('consumes the attempt on transient failure, without tool retry or a second effect', async () => {
    const agent = executor();
    const create = jest.fn<() => Promise<any>>().mockResolvedValue(completion([call('first'), call('second')]));
    (agent as any).client.chat.completions.create = create;
    let effects = 0;
    const execute = jest.fn(async () => { effects++; throw new Error('socket timeout after write'); });
    const result = await agent.act({ tools: [{ name: 'write', execute }], prompt: 'Write', enforceSingleTurn: true });
    expect(effects).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(toolResponses(result.messages, ['first', 'second'])).toHaveLength(2);
    expect(result.steps[0].toolResults?.every(value => value.isError)).toBe(true);
  });

  it('handles malformed/unknown calls without consuming the one actual execution', async () => {
    const agent = executor();
    const create = jest.fn<() => Promise<any>>().mockResolvedValue(completion([
      call('malformed', 'write', 'not JSON'), call('unknown', 'missing'), call('first'), call('second'),
    ]));
    (agent as any).client.chat.completions.create = create;
    const execute = jest.fn<() => Promise<any>>().mockResolvedValue('written');
    const result = await agent.act({ tools: [{ name: 'write', execute }], prompt: 'Write', enforceSingleTurn: true });
    expect(execute).toHaveBeenCalledTimes(1);
    toolResponses(result.messages, ['malformed', 'unknown', 'first', 'second']);
    const assistant = result.messages.find(message => message.tool_calls);
    expect(assistant?.tool_calls?.[0].function.arguments).toBe('{}');
  });

  it('does not start a second model turn when all calls have malformed arguments', async () => {
    const agent = executor();
    const create = jest.fn<() => Promise<any>>().mockResolvedValue(completion([call('bad', 'write', 'not JSON')]));
    (agent as any).client.chat.completions.create = create;
    const execute = jest.fn<() => Promise<any>>();
    const result = await agent.act({ tools: [{ name: 'write', execute }], prompt: 'Write', enforceSingleTurn: true, maxIterations: 3 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    toolResponses(result.messages, ['bad']);
    expect(result.steps).toHaveLength(1);
  });

  it('places skipped results before image user messages so returned history can be resumed', async () => {
    const agent = executor();
    const create = jest.fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValueOnce(completion([call('screenshot'), call('skipped')]))
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    (agent as any).client.chat.completions.create = create;
    const execute = jest.fn<() => Promise<any>>().mockResolvedValue(`data:image/png;base64,${'A'.repeat(100)}`);
    const tools = [{ name: 'write', execute }];
    const result = await agent.act({ tools, prompt: 'Write', enforceSingleTurn: true });
    toolResponses(result.messages, ['screenshot', 'skipped']);
    expect(result.messages.at(-1)?.role).toBe('user');
    await agent.act({ tools, messages: result.messages, enforceSingleTurn: true });
    toolResponses(create.mock.calls[1][0].messages, ['screenshot', 'skipped']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('counts a locally handled wait as the one action', async () => {
    const agent = executor();
    (agent as any).client.chat.completions.create = async () => completion([
      call('wait', 'computer', '{"action":"wait","duration":1}'), call('skipped'),
    ]);
    const execute = jest.fn<() => Promise<any>>();
    const result = await agent.act({ tools: [{ name: 'computer', execute }, { name: 'write', execute }], prompt: 'Wait', enforceSingleTurn: true });
    expect(execute).not.toHaveBeenCalled();
    const responses = toolResponses(result.messages, ['wait', 'skipped']);
    expect(responses[0].content).toContain('Waited');
    expect(JSON.parse(responses[1].content as string).executed).toBe(false);
  });

  it('preserves multi-call behavior when the boundary is disabled', async () => {
    const agent = executor();
    const create = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(completion([call('first'), call('second')]));
    (agent as any).client.chat.completions.create = create;
    const execute = jest.fn<() => Promise<any>>().mockResolvedValue('written');
    await agent.act({ tools: [{ name: 'write', execute }], prompt: 'Write', enforceSingleTurn: false, maxIterations: 1 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).not.toHaveProperty('parallel_tool_calls');
  });
});