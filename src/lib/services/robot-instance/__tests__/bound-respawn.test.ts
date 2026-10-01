import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type AsyncMock = (...args: unknown[]) => Promise<unknown>;
const claim = jest.fn<AsyncMock>();
const start = jest.fn<AsyncMock>();
const insert = jest.fn<AsyncMock>();
const workflow = () => {};
jest.unstable_mockModule('../assistant-recovery', () => ({ claimAssistantRecovery: claim }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: () => ({ insert }) } }));
jest.unstable_mockModule('workflow/api', () => ({ start }));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/workflow', () => ({ runAssistantWorkflow: workflow }));
let spawnSilentContinueWorkflow: typeof import('../assistant-respawn').spawnSilentContinueWorkflow;
beforeAll(async () => { ({ spawnSilentContinueWorkflow } = await import('../assistant-respawn')); });

const scope = { instanceId: 'instance', siteId: 'site', userId: 'user', userMessageLogId: 'original-user-log' };
const execution = {
  customTools: [{ name: 'custom' }], useSdkTools: false, systemPrompt: 'Original system prompt',
  instanceNodeId: 'original-publish-node', expectedResultsAmount: 1,
  contextString: '{"publish_destinations":["tiktok"],"nodeType":"publish"}',
  toolOverrides: { publish: { social_accounts: ['tt-account'], media_urls: ['https://example.com/video.mp4'] } },
  selectedSkills: { skill_mode: 'auto', skills: [] }, approvedImport: undefined,
};
beforeEach(() => {
  jest.resetAllMocks();
  claim.mockResolvedValue({ resumeToken: 'private-resume-token', snapshot: { execution, respawnCount: 1 } });
  start.mockResolvedValue({ runId: 'new-run' }); insert.mockResolvedValue({ error: null });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('durable bound respawn', () => {
  it('starts exclusively from the claimed original node execution and passes the resume token', async () => {
    expect(await spawnSilentContinueWorkflow(scope)).toBe(true);
    expect(claim).toHaveBeenCalledWith(scope);
    const args = start.mock.calls[0][1] as unknown[];
    expect(args[9]).toBe('original-publish-node');
    expect(args[11]).toBe(execution.contextString);
    expect(args[12]).toEqual(execution.toolOverrides);
    expect(args[13]).toMatchObject({ silentContinue: true, userMessageLogId: 'original-user-log', resumeToken: 'private-resume-token' });
    expect(args[6]).toBe(execution.systemPrompt);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({
      instance_node_id: 'original-publish-node', user_message_log_id: 'original-user-log', generation: 1,
    }) }));
    expect(JSON.stringify(insert.mock.calls)).not.toContain('private-resume-token');
  });
  it('does not start or log a restart for a cancelled, stale or missing checkpoint', async () => {
    claim.mockRejectedValue(new Error('inactive'));
    expect(await spawnSilentContinueWorkflow(scope)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it('does not retry ambiguous workflow startup', async () => {
    start.mockRejectedValue(new Error('Gateway timeout after acceptance'));
    expect(await spawnSilentContinueWorkflow(scope)).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});