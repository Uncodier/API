import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Message } from '../ai-agent-executor';
import { loadExecutorRuntime } from '../test-helpers/load-executor-runtime';

const { AIAgentExecutor } = loadExecutorRuntime();

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('recovery errors remain control flow, not tool failures', () => {
  it.each([
    { afterEffect: true, contentFilter: false },
    { afterEffect: false, contentFilter: false },
    { afterEffect: true, contentFilter: true },
  ])('does not retry or fabricate receipts: %j', async ({ afterEffect, contentFilter }) => {
    const endpoint = new URL('https://example.invalid');
    const agent = new AIAgentExecutor({ provider: 'openrouter', apiKey: randomBytes(24).toString('hex'),
      model: 'test-model', baseURL: endpoint.href });
    const calls = ['write', 'forbidden'].map((name, index) => ({ id: `call-${index}`, type: 'function', function: { name, arguments: '{}' } }));
    const create = jest.fn<() => Promise<any>>().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: calls }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
    (agent as any).client.chat.completions.create = create;
    const failure = Object.assign(new Error(contentFilter ? 'content management policy' : 'socket timeout saving observation'),
      { name: 'RecoveryError', ...(contentFilter ? { code: 'content_filter' } : {}) });
    const effect = jest.fn(async () => ({ accepted: true }));
    const execute = jest.fn(async () => { if (afterEffect) await effect(); throw failure; });
    const forbidden = jest.fn(async () => 'must not run');
    const onStep = jest.fn(async () => {});
    let observedMessages: Message[] = [];
    await expect(agent.act({ prompt: 'Perform the requested work', tools: [
      { name: 'write', execute }, { name: 'forbidden', execute: forbidden },
    ], enforceSingleTurn: false, maxIterations: 3, onStep,
    onContextUsage: async snapshot => { observedMessages = snapshot.messages; },
    })).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(afterEffect ? 1 : 0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
    expect(onStep).not.toHaveBeenCalled();
    expect(observedMessages.some(message => message.role === 'tool')).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
it('keeps qualified names, arguments, rejection transcripts and decorated schema text out of real executor console paths', async () => {
  const secret = randomBytes(24).toString('hex');
  const agent = new AIAgentExecutor({model:'test-model'});
  const create = jest.fn<() => Promise<any>>().mockResolvedValueOnce({ choices:[{message:{role:'assistant',content:'',tool_calls:[
    {id:'call-private',type:'function',function:{name:`report:${secret}`,arguments:JSON.stringify({body:secret})}},
  ]},finish_reason:'tool_calls'}], usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15} });
  (agent as any).client.chat.completions.create = create;
  const tools = [{name:'tools',description:secret,parameters:{type:'object',properties:{query:{type:'string',description:secret}}},execute:jest.fn(async()=>({success:true}))}];
  const turn = await agent.act({prompt:'Test',tools,maxIterations:1});
  // Actual model protocol isn't rewritten for logging, including the unknown call.
  expect(JSON.stringify(turn.messages)).toContain(secret);
  create.mockRejectedValueOnce(Object.assign(new Error('invalid tool_call_id'),{status:400}));
  await expect(agent.act({messages:turn.messages,tools,maxIterations:1})).rejects.toThrow('tool_call_id');
  for (const channel of [console.log,console.error,console.warn]) expect(JSON.stringify(jest.mocked(channel).mock.calls)).not.toContain(secret);
  expect(tools[0].execute).not.toHaveBeenCalled();
});
