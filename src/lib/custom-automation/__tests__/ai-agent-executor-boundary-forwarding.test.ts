import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { randomUUID } from 'node:crypto';
import { hydrateMessageImages } from '@/lib/services/robot-instance/vision-message-images';
import { createStreamingLogCallbacks, createThinkingStreamLogCallbacks } from '@/lib/services/robot-instance/assistant-streaming-logs';
import { AIAgentExecutor } from '../ai-agent-executor';
import { AssistantExecutionBoundaryError, type AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';
import { prepareNodeExecutionContext } from '@/lib/services/robot-instance/assistant-node-context';
import { createAssistantOnStepHandler } from '@/lib/services/robot-instance/assistant-logging';

jest.mock('../ai-agent-executor', () => ({ AIAgentExecutor: jest.fn() }));
jest.mock('@/lib/services/robot-instance/assistant-executor-legacy', () => ({ executeAssistant: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { requireCredits: jest.fn() } }));
jest.mock('@/lib/services/robot-instance/assistant-logging', () => ({
  createAssistantOnStepHandler: jest.fn(), batchCreateResponseNodes: jest.fn(async () => ['response-1', 'response-2']),
}));
jest.mock('@/lib/services/robot-instance/assistant-streaming-logs', () => ({
  createStreamingLogCallbacks: jest.fn(), createThinkingStreamLogCallbacks: jest.fn(), createNodeStreamingCallbacks: jest.fn(),
}));
jest.mock('@/lib/services/robot-instance/vision-message-images', () => ({ hydrateMessageImages: jest.fn(async (messages: any[]) => messages) }));
jest.mock('@/lib/services/robot-instance/InstanceContextManager', () => ({ InstanceContextManager: jest.fn() }));
jest.mock('@/lib/services/robot-instance/instance-context-budget', () => ({ measureInstanceContext: jest.fn() }));
jest.mock('@/lib/services/robot-instance/assistant-node-context', () => ({ prepareNodeExecutionContext: jest.fn() }));
jest.mock('@/lib/services/robot-instance/assistant-node-results', () => ({
  createNodeChunkWriter: () => ({ finish: async () => true, fail: async () => {}, onChunk: async () => {} }),
  finalNodeAssistantText: () => 'Done',
}));

const executionBoundary: AssistantExecutionBoundary = {
  beforeModel: async () => {}, onModelMessage: async () => {},
  executeTool: async (_call, execute) => execute(), afterTurn: async () => {},
};
const completed = { messages: [{ role: 'assistant', content: 'Done' }], text: 'Done', steps: [], usage: {} };
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('forwards host boundary and output limit without replacing canonical onStep (fan-out=%s)', async fanOut => {
  const act = jest.fn().mockResolvedValue(completed);
  jest.mocked(AIAgentExecutor).mockImplementation(() => ({ act }) as any);
  const onStep = jest.fn();
  jest.mocked(createAssistantOnStepHandler).mockReturnValue(onStep);
  jest.mocked(prepareNodeExecutionContext).mockResolvedValue({ messages: [], systemPrompt: 'Host prompt',
    ...(fanOut ? { promptNode: { id: 'prompt' }, contextRefs: [] } : {}) } as any);
  await executeAssistantStep([], {}, { executionBoundary, maxOutputTokens: 2048,
    ...(fanOut ? { instance_node_id: 'prompt', expected_results_amount: 2 } : {}) });
  expect(act).toHaveBeenCalledTimes(fanOut ? 2 : 1);
  for (const [options] of act.mock.calls) {
    expect(options.executionBoundary).toBe(executionBoundary);
    expect(options.maxOutputTokens).toBe(2048);
    expect(options.onStep).toBe(onStep);
    expect(options.stream).toBe(false);
  }
  expect(jest.mocked(createAssistantOnStepHandler).mock.calls[0][8]).toMatchObject({ strict: true });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('does not hide a fatal boundary rejection behind partial fan-out success', async () => {
  const failure = new AssistantExecutionBoundaryError();
  const act = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(completed);
  jest.mocked(AIAgentExecutor).mockImplementation(() => ({ act }) as any);
  jest.mocked(prepareNodeExecutionContext).mockResolvedValue({ messages: [], systemPrompt: 'Host prompt',
    promptNode: { id: 'prompt' }, contextRefs: [] } as any);
  await expect(executeAssistantStep([], {}, { executionBoundary,
    instance_node_id: 'prompt', expected_results_amount: 2 })).rejects.toBe(failure);
});

it('routes linked Record evidence to inference without media downloads or shared step/stream/context hooks', async () => {
  const privateText = `Private row ${randomUUID()}`;
  const messages = [{role:'user',content:privateText}];
  const act = jest.fn().mockResolvedValue({...completed,text:privateText});
  jest.mocked(AIAgentExecutor).mockImplementation(() => ({act}) as any);
  jest.mocked(prepareNodeExecutionContext).mockResolvedValue({messages,systemPrompt:'Source rules'} as any);
  await executeAssistantStep(messages,{}, {ownerConnectorContext:true,privateAssetsHydrated:true,site_id:randomUUID(),instance_id:randomUUID()});
  expect(act).toHaveBeenCalledTimes(1);
  expect(act.mock.calls[0][0]).toMatchObject({messages,stream:false,onStep:undefined,onContextUsage:undefined,
    privateToolContext:true,preserveToolExecution:true});
  for (const hook of [hydrateMessageImages,createAssistantOnStepHandler,createStreamingLogCallbacks,createThinkingStreamLogCallbacks,globalThis.fetch]) {
    expect(hook).not.toHaveBeenCalled();
  }
  expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(privateText);
});
