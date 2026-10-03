import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AssistantContext } from '../types';

type AsyncMock = (...args: any[]) => Promise<any>;
const assertActive = jest.fn<AsyncMock>();
const resolveBinding = jest.fn<AsyncMock>();
const execute = jest.fn<AsyncMock>();
const toolExecute = jest.fn<AsyncMock>();
const getTools = jest.fn<AsyncMock>();
const observeTool = jest.fn<AsyncMock>();
jest.unstable_mockModule('@/lib/services/robot-instance/assistant-recovery', () => ({
  assertAssistantRecoveryActive: assertActive, runAssistantRecoveryTool: observeTool,
}));
jest.unstable_mockModule('../publish-node-binding', () => ({ resolvePublishNodeBinding: resolveBinding }));
jest.unstable_mockModule('@/lib/services/robot-instance/assistant-executor', () => ({ executeAssistantStep: execute }));
jest.unstable_mockModule('../utils', () => ({ getInstanceAssistantTools: getTools }));
jest.unstable_mockModule('@/lib/services/robot-instance/vision-message-images', () => ({
  hydrateMessageImages: async (messages: unknown[]) => messages, dehydrateMessageImages: (messages: unknown[]) => messages,
}));
jest.unstable_mockModule('@/lib/services/workflow-robot/execution-tracker', () => ({ instrumentWorkflowTools: (tools: unknown[]) => tools }));
let processAssistantTurn: typeof import('../assistant-turn').processAssistantTurn;
beforeAll(async () => { ({ processAssistantTurn } = await import('../assistant-turn')); });
const scope = { instanceId: 'instance', siteId: 'site', userId: 'user', userMessageLogId: 'log' };
const context: AssistantContext = {
  instance: {}, systemPrompt: 'Publish', customTools: [], imageAssets: [], initialMessage: 'Publish',
  hasLinkedRequirement: false, expectedResultsAmount: 1, instanceNodeId: 'node', recoveryScope: scope,
  nodeContinuation: { responseNodeIds: ['response'] },
  executionOptions: { instance_id: 'instance', site_id: 'site', user_id: 'user', use_sdk_tools: false, provider: 'azure' },
};
beforeEach(() => {
  jest.resetAllMocks(); assertActive.mockResolvedValue(undefined); toolExecute.mockResolvedValue('sent');
  observeTool.mockImplementation(async (_scope, _name, _args, executeTool) => executeTool());
  getTools.mockResolvedValue([{ name: 'tools', execute: toolExecute }]);
  resolveBinding.mockResolvedValue({ instruction: 'Bound', toolOverrides: {
    publish: { social_accounts: ['tiktok'], media_urls: ['https://example.com/original.mp4'], urls: [], assets: [] },
  } });
  execute.mockResolvedValue({ messages: [], text: 'Done', isDone: true });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('per-turn and per-tool recovery guards', () => {
  it('forwards authoritative content binding and same response-node continuation', async () => {
    await processAssistantTurn(context, []);
    const options = execute.mock.calls[0][2];
    expect(options.instance_node_id).toBe('node');
    expect(options.node_continuation).toEqual({ responseNodeIds: ['response'] });
    expect(options.tool_overrides.publish).toMatchObject({ social_accounts: ['tiktok'], media_urls: ['https://example.com/original.mp4'] });
    await options.custom_tools[0].execute({ action: 'call' });
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(observeTool).toHaveBeenCalledWith(scope, 'tools', { action: 'call' }, expect.any(Function));
  });
  it('blocks before the model when the original action or context changed', async () => {
    assertActive.mockRejectedValue(new Error('cancelled'));
    await expect(processAssistantTurn(context, [])).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });
  it('blocks effects when cancellation happens while the model is responding', async () => {
    await processAssistantTurn(context, []);
    assertActive.mockRejectedValue(new Error('cancelled'));
    await expect(execute.mock.calls[0][2].custom_tools[0].execute({ action: 'call' })).rejects.toThrow('cancelled');
    expect(toolExecute).not.toHaveBeenCalled();
  });
  it('does not run a node when its Content binding is missing', async () => {
    resolveBinding.mockRejectedValue(new Error('Missing Content input'));
    await expect(processAssistantTurn(context, [])).rejects.toThrow('Missing Content');
    expect(execute).not.toHaveBeenCalled();
  });
  it('replaces hallucinated images and additional social destinations at tool execution', async () => {
    await processAssistantTurn(context, []);
    await execute.mock.calls[0][2].custom_tools[0].execute({ action: 'call', name: 'publish', args: JSON.stringify({
      text: 'Caption', media_urls: ['https://example.com/reference.jpg'], social_accounts: ['instagram', 'tiktok'],
    }) });
    const args = JSON.parse(toolExecute.mock.calls[0][0].args);
    expect(args.media_urls).toEqual(['https://example.com/original.mp4']);
    expect(args.social_accounts).toEqual(['tiktok']);
    expect(args.text).toBe('Caption');
  });
  it('does not allow a blog-only node to add a social destination', async () => {
    resolveBinding.mockResolvedValue({ instruction: 'Blog only', toolOverrides: { publish: {} } });
    await processAssistantTurn(context, []);
    await execute.mock.calls[0][2].custom_tools[0].execute({ action: 'call', name: 'publish', args: JSON.stringify({
      title: 'Blog', type: 'blog_post', social_accounts: ['instagram'], tiktok: { postMode: 'DIRECT_POST' },
    }) });
    const args = JSON.parse(toolExecute.mock.calls[0][0].args);
    expect(args).not.toHaveProperty('social_accounts');
    expect(args).not.toHaveProperty('tiktok');
    expect(args.type).toBe('blog_post');
  });
  it('disables replay of an effectful durable step', () => {
    expect(processAssistantTurn.maxRetries).toBe(0);
  });
});