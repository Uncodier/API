import { randomBytes } from 'node:crypto';
import * as openrouter from '@/lib/services/ai/openrouter';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as zod from 'zod';
import * as jsonSchema from 'zod-to-json-schema';
import * as azureVision from '../azure-vision-message-sanitize';
import * as geminiMessages from '../gemini-message-sanitize';
import * as toolArguments from '../coerce-tool-args';
import * as toolResults from '@/lib/services/tool-operation-result';
import type { Message } from '../ai-agent-executor';
import { loadRuntimeModule } from '../test-helpers/load-runtime-module';

class OfflineOpenAI {
  chat = { completions: { create: () => { throw new Error('Unexpected provider I/O'); } } };
}
const { AIAgentExecutor } = loadRuntimeModule<typeof import('../ai-agent-executor')>(
  'src/lib/custom-automation/ai-agent-executor.ts', {
    openai: OfflineOpenAI, 'google-auth-library': { GoogleAuth: class {} }, zod,
    '@/lib/services/ai/openrouter': { ...openrouter, createOpenRouterClient: () => new OfflineOpenAI() },
    'zod-to-json-schema': jsonSchema, './azure-vision-message-sanitize': azureVision,
    './gemini-message-sanitize': geminiMessages, './coerce-tool-args': toolArguments,
    '@/lib/services/tool-operation-result': toolResults,
    '@/lib/services/robot-instance/instance-context-budget': {
      fitInstanceRequest: () => { throw new Error('Unexpected context I/O'); },
      resolveModelContextCapacity: () => { throw new Error('Unexpected context I/O'); },
    },
  },
);

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