import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { recoveryDatabase, scope } from '@/lib/services/robot-instance/test-support/assistant-recovery-fixture';

let db: ReturnType<typeof recoveryDatabase>;
let resumedToken = '';
let runCount = 0;
let sent = 0;
let claimRecovery: typeof import('@/lib/services/robot-instance/assistant-recovery').claimAssistantRecovery;
let resolveBinding: typeof import('../publish-node-binding').resolvePublishNodeBinding;
const model = jest.fn<(...args: any[]) => Promise<any>>();
const prepare = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<(...args: any[]) => Promise<void>>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (table: string) => db.from(table) } }));
jest.unstable_mockModule('../assistant-turn', () => ({ processAssistantTurn: model }));
jest.unstable_mockModule('../steps', () => ({ prepareAssistantContext: prepare }));
jest.unstable_mockModule('../plan-steps', () => ({
  getActiveInstancePlan: async () => null, executePlanStep: jest.fn(), acquirePlanExecutionLockStep: jest.fn(), releasePlanExecutionLockStep: jest.fn(),
}));
jest.unstable_mockModule('../persist-and-fail-steps', () => ({
  persistUserMessageStep: async () => ({ id: scope.userMessageLogId }),
  completeUserMessageStep: complete, pauseUserMessageStep: jest.fn(), markAssistantFailedStep: jest.fn(),
}));
jest.unstable_mockModule('../assistant-respawn-steps', () => ({
  spawnSilentContinueStep: async (request: typeof scope) => {
    resumedToken = (await claimRecovery(request)).resumeToken;
    return true;
  },
}));
let run: typeof import('../workflow').runAssistantWorkflow;
beforeAll(async () => {
  ({ runAssistantWorkflow: run } = await import('../workflow'));
  ({ claimAssistantRecovery: claimRecovery } = await import('@/lib/services/robot-instance/assistant-recovery'));
  ({ resolvePublishNodeBinding: resolveBinding } = await import('../publish-node-binding'));
});

const video = 'https://db.makinari.com/storage/v1/object/public/generative_videos/site-1/original.mp4';
const image = 'https://db.makinari.com/storage/v1/object/public/generative_images/site-1/reference.jpg';
beforeEach(() => {
  jest.clearAllMocks(); db = recoveryDatabase(); resumedToken = ''; runCount = 0; sent = 0;
  db.tables.instance_nodes = [
    { id: 'publish-node', type: 'publish', instance_id: scope.instanceId, site_id: scope.siteId,
      parent_node_id: null, status: 'running', prompt: { text: 'Publish the video' }, result: null,
      settings: { publish_destinations: ['tiktok'], ui_position: { x: 1, y: 1 } } },
    { id: 'video-node', type: 'response', instance_id: scope.instanceId, site_id: scope.siteId,
      parent_node_id: null, status: 'completed', settings: {}, prompt: {},
      result: { text: 'Original video', outputs: [{ type: 'video', data: { url: video } }] } },
    { id: 'reference-node', type: 'response', instance_id: scope.instanceId, site_id: scope.siteId,
      parent_node_id: null, status: 'completed', settings: {}, prompt: {},
      result: { text: 'Reference only', outputs: [{ type: 'image', data: { url: image } }] } },
  ];
  db.tables.instance_node_contexts = [
    { target_node_id: 'publish-node', context_node_id: 'video-node', type: 'content', site_id: scope.siteId },
    { target_node_id: 'publish-node', context_node_id: 'reference-node', type: 'context', site_id: scope.siteId },
  ];
  prepare.mockImplementation(async (instanceId, message, siteId, userId, customTools, _sdk, systemPrompt,
    _type, _phone, instanceNodeId, expectedResultsAmount, _context, toolOverrides) => ({
    instance: {}, systemPrompt, initialMessage: message, customTools, instanceNodeId, expectedResultsAmount,
    toolOverrides, imageAssets: [], hasLinkedRequirement: false,
    executionOptions: { instance_id: instanceId, site_id: siteId, user_id: userId, provider: 'azure', use_sdk_tools: false },
  }));
  complete.mockImplementation(async () => { db.action().details.status = 'completed'; });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('bound recovery using real checkpoint and content selection code', () => {
  it('retains the exact video, destination, private option, transcript and response across a background restart', async () => {
    const receipt = { role: 'tool', tool_call_id: 'publish-1', content: '{"post_id":"sent-once","retry_safe":false}' };
    model.mockImplementation(async (context, messages) => {
      runCount++;
      const binding = await resolveBinding({ instanceNodeId: context.instanceNodeId,
        instanceId: scope.instanceId, siteId: scope.siteId, toolOverrides: context.toolOverrides });
      expect(binding?.toolOverrides.publish).toMatchObject({
        social_accounts: ['tiktok'], media_urls: [video], tiktok: { privacyLevel: 'SELF_ONLY' },
      });
      if (runCount === 1) { sent++; messages = [...messages, receipt]; }
      else expect(messages).toContainEqual(receipt);
      const done = runCount === 21;
      if (done) expect(context.nodeContinuation).toEqual({ responseNodeIds: ['same-response'] });
      return { messages, text: done ? 'Accepted; do not resend' : '', isDone: done,
        continuation: { responseNodeIds: ['same-response'] }, steps: [], usage: {} };
    });
    const options = { userMessageLogId: scope.userMessageLogId };
    const first = await run(scope.instanceId, 'Publish the video', scope.siteId, scope.userId, [], false,
      'Only use Content', undefined, undefined, 'publish-node', 1, '{"publish_destinations":["tiktok"]}',
      { publish: { tiktok: { privacyLevel: 'SELF_ONLY' } } }, options);
    expect(first).toMatchObject({ success: false, execution_status: 'continuing' });
    expect(db.snapshot().respawnCount).toBe(1);
    const resumed = await run(scope.instanceId, 'Continue', scope.siteId, scope.userId, [], false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { ...options, silentContinue: true, resumeToken: resumedToken });
    expect(resumed.assistant_response).toBe('Accepted; do not resend');
    expect(resumed.instance_node_id).toBe('publish-node');
    expect(db.action().details.status).toBe('completed');
    expect(sent).toBe(1);
    expect(db.snapshot().messages).toContainEqual(receipt);
  });
});