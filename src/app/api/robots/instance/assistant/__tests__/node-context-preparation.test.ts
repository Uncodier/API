jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/robot-instance/InstanceContextManager', () => ({
  InstanceContextManager: jest.fn(),
}));
jest.mock('@/lib/services/robot-instance/InstanceAssetsService', () => ({
  InstanceAssetsService: { getAssetsContext: jest.fn() },
}));
jest.mock('../utils', () => ({
  fetchMemoriesContext: jest.fn(async () => ''),
  generateAgentBackground: jest.fn(async () => ''),
  getInstanceAssistantTools: jest.fn(async () => []),
  determineInstanceCapabilities: () => ({ capabilities: {}, shouldUseSDKTools: false }),
  getRequirementWorkflowInstruction: () => '',
}));
jest.mock('../requirement-context', () => ({
  loadAssistantRequirementContext: jest.fn(async () => ({ activeRequirementId: null })),
}));
jest.mock('../skill-selection', () => ({ requiredSkillsPrompt: () => '' }));
jest.mock('../history-model', () => ({
  resolveAssistantHistoryModel: () => ({ provider: 'openrouter', model: 'test-model' }),
}));
jest.mock('@/lib/services/robot-instance/assistant-logging', () => ({ fetchNodeContexts: jest.fn(async () => []) }));
jest.mock('@/app/api/agents/tools/publish/social-media', () => ({ validateSocialMediaAttachment: jest.fn() }));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { InstanceContextManager } from '@/lib/services/robot-instance/InstanceContextManager';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';
import { getInstanceAssistantTools, generateAgentBackground } from '../utils';
import { prepareAssistantContext } from '../steps';

const INSTANCE = 'instance-1';
const SITE = 'site-1';
const USER = 'user-1';
const NODE = 'node-1';
const buildHistory = jest.fn(async () => 'Ordinary conversation history');
let nodeAvailable = true;

function prepare(contextString?: string, nodeId?: string) {
  return prepareAssistantContext(INSTANCE, 'User request', SITE, USER, [], false,
    undefined, undefined, undefined, nodeId, 1, contextString);
}

beforeEach(() => {
  jest.clearAllMocks();
  nodeAvailable = true;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  (InstanceContextManager as jest.Mock).mockImplementation(() => ({ buildHistory }));
  (InstanceAssetsService.getAssetsContext as jest.Mock).mockResolvedValue({
    text: 'Conversation asset context', images: [{ url: 'https://assets.example.test/image.png' }],
  });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = jest.fn(() => query);
    query.single = jest.fn(async () => ({
      data: { id: INSTANCE, site_id: SITE, user_id: USER, name: 'Project', status: 'uninstantiated' }, error: null,
    }));
    query.limit = jest.fn(async () => ({ data: [], error: null }));
    query.maybeSingle = jest.fn(async () => ({
      data: table === 'instance_nodes' && nodeAvailable
        ? { id: NODE, instance_id: INSTANCE, site_id: SITE, type: 'generate-image', settings: {} } : null,
      error: null,
    }));
    return query;
  });
});
afterEach(() => jest.restoreAllMocks());

it.each([
  { nodeType: 'publish', publish_destinations: ['tiktok'] },
  { nodeType: 'audience', mediaType: 'audience' },
  { nodeType: 'text', output_type: 'text' },
  { nodeType: 'generate-image', media_type: 'image', parameters: {} },
  { ui_contract: { version: 1, output_type: 'video' } },
  { instanceNodeId: 'embedded-node' },
])('rejects direct/replayed unscoped preparation before conversation data/tools: %j', async context => {
  await expect(prepare(JSON.stringify(context))).rejects.toThrow('NODE_CONTEXT_REQUIRES_NODE');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(InstanceContextManager).not.toHaveBeenCalled();
  expect(InstanceAssetsService.getAssetsContext).not.toHaveBeenCalled();
  expect(generateAgentBackground).not.toHaveBeenCalled();
  expect(getInstanceAssistantTools).not.toHaveBeenCalled();
});

it.each([
  'Ordinary conversation context', 'null', '[]', '{"nodeType":',
  JSON.stringify({ output_type: 'json', records: [{ nodeType: 'publish' }] }),
])('keeps ordinary context and conversation identity/history/assets: %s', async serialized => {
  const context = await prepare(serialized);
  expect(context.executionOptions).toMatchObject({ instance_id: INSTANCE, site_id: SITE, user_id: USER });
  expect(context.instanceNodeId).toBeUndefined();
  expect(context.systemPrompt).toContain(serialized);
  expect(context.systemPrompt).toContain('Ordinary conversation history');
  expect(context.systemPrompt).toContain('Conversation asset context');
  expect(context.systemPrompt).not.toContain('PUBLISH NODE TASK');
  expect(context.systemPrompt).not.toContain('VISUAL NODE MODE');
  expect(buildHistory).toHaveBeenCalledTimes(1);
});

it.each(['text', 'image', 'video', 'audio', 'audience'])('prepares conversational %s preferences without switching to node mode', async mediaType => {
  const serialized = JSON.stringify({ mediaType, output_type: mediaType, parameters: { tone: 'friendly' } });
  const toolOverrides = { search: { limit: 3 } };
  const context = await prepareAssistantContext(INSTANCE, 'User request', SITE, USER, [], false,
    undefined, undefined, undefined, undefined, 3, serialized, toolOverrides);
  expect(context.instanceNodeId).toBeUndefined();
  expect(context.uiMediaOutputType).toBeUndefined();
  expect(context.expectedResultsAmount).toBe(3);
  expect(context.toolOverrides).toEqual(toolOverrides);
  expect(context.executionOptions).toMatchObject({ instance_id: INSTANCE, site_id: SITE, user_id: USER });
  expect(context.systemPrompt).toContain('friendly');
  expect(context.systemPrompt).toContain('Ordinary conversation history');
  expect(context.systemPrompt).toContain('Conversation asset context');
  expect(context.systemPrompt).not.toContain('VISUAL NODE MODE');
  expect(buildHistory).toHaveBeenCalledTimes(1);
  expect(getInstanceAssistantTools).toHaveBeenCalled();
  expect((supabaseAdmin.from as jest.Mock).mock.calls.map(([table]) => table)).not.toContain('instance_nodes');
});

it('requires supplied node identity to resolve in the requested site and instance', async () => {
  nodeAvailable = false;
  await expect(prepare(JSON.stringify({ nodeType: 'generate-image' }), 'foreign-node'))
    .rejects.toThrow('UI node does not belong to the requested site and instance');
  expect(buildHistory).not.toHaveBeenCalled();
  expect(getInstanceAssistantTools).not.toHaveBeenCalled();
  expect(InstanceAssetsService.getAssetsContext).not.toHaveBeenCalled();
});

it('validates a supplied node against the site and instance even with generic preferences', async () => {
  nodeAvailable = false;
  await expect(prepare(JSON.stringify({ mediaType: 'text', output_type: 'text' }), 'foreign-node'))
    .rejects.toThrow('UI node does not belong to the requested site and instance');
  expect(buildHistory).not.toHaveBeenCalled();
  expect(getInstanceAssistantTools).not.toHaveBeenCalled();
});

it('preserves explicit node identity and skips conversation history after scoped resolution', async () => {
  const context = await prepare(JSON.stringify({ nodeType: 'generate-image', instanceNodeId: 'embedded-node' }), NODE);
  expect(context.instanceNodeId).toBe(NODE);
  expect(context.uiMediaOutputType).toBe('image');
  expect(context.executionOptions).toMatchObject({ instance_id: INSTANCE, site_id: SITE, user_id: USER });
  expect(context.systemPrompt).toContain('VISUAL NODE MODE');
  expect(buildHistory).not.toHaveBeenCalled();
  expect(context.systemPrompt).not.toContain('Conversation asset context');
});