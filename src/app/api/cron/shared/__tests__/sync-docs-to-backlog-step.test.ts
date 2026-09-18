import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const executeAssistantStep = jest.fn(async () => ({ messages: [], isDone: true }));
const patchRequirementMetadataKeys = jest.fn(async () => ({
  last_docs_to_backlog_sync_at: '2026-09-17T12:00:00.000Z',
  concurrent_key: 'preserved',
}));
const single = jest.fn(async () => ({
  data: {
    metadata: { unrelated_key: 'stale-value' },
    backlog: { items: [] },
    type: 'app',
    title: 'Test requirement',
  },
}));
const eq = jest.fn(() => ({ single }));
const select = jest.fn(() => ({ eq }));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn(() => ({ select })) },
}));
jest.mock('@/lib/services/robot-instance/assistant-executor', () => ({
  executeAssistantStep,
}));
jest.mock('@/lib/services/docs-cycle-digest', () => ({
  loadLatestDocsDigestFromLogs: jest.fn(async () => [{ path: 'README.md', summary: 'New endpoint' }]),
  formatDigestForPrompt: jest.fn(() => 'Digest'),
}));
jest.mock('@/app/api/agents/tools/requirement_backlog/assistantProtocol', () => ({
  requirementBacklogTool: jest.fn(() => ({ name: 'requirement_backlog' })),
}));
jest.mock('@/lib/services/requirement-metadata-patch', () => ({
  patchRequirementMetadataKeys,
}));

describe('emitSyncDocsToBacklogStep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('patches only the sync timestamp so concurrent metadata keys survive', async () => {
    const { emitSyncDocsToBacklogStep } = await import('../sync-docs-to-backlog-step');

    await expect(emitSyncDocsToBacklogStep({
      siteId: 'site-1',
      instanceId: 'instance-1',
      requirementId: 'requirement-1',
      digest: { emitted: true } as any,
    })).resolves.toEqual({ ran: true });

    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(patchRequirementMetadataKeys).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      patch: {
        last_docs_to_backlog_sync_at: expect.any(String),
      },
    });
  });
});
