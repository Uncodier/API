import { randomUUID } from 'node:crypto';
import { requirementCheckpointHook } from '../requirement-checkpoint-hook';
import type { Workspace } from '../types';

const checkpoint = jest.fn();
jest.mock('../requirement-checkpoint', () => ({ checkpointRequirementWorkspace: (...args: unknown[]) => checkpoint(...args) }));

function setup() {
  const run = { requirementId: randomUUID(), sessionId: randomUUID(), siteId: randomUUID(), userId: randomUUID(),
    instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1 };
  const query: any = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(async () => ({ data: { baseline: { version: 1 } }, error: null })) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const client = { from: jest.fn(() => query), rpc: jest.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: true, error: null })) };
  const profile = { siteId: run.siteId, userId: run.userId, repositoryUrl: 'https://github.com/example/test.git', allowed: [], environment: {} };
  const input = { workspace: {} as Workspace, redact: (text: string) => text, owner: randomUUID(),
    assertActive: jest.fn(async () => {}), signal: new AbortController().signal };
  return { run, query, client, input, hook: requirementCheckpointHook({ run, profile, client,
    repositoryUrl: profile.repositoryUrl, branch: `feature/req-${run.requirementId}`, baseRef: 'main' }) };
}
beforeEach(() => { jest.clearAllMocks(); });

it('passes only host configuration and private baseline, then persists verified receipt with both owners', async () => {
  const s = setup();
  checkpoint.mockResolvedValue({ state: 'saved', sha: 'a'.repeat(40), repoUrl: 'https://github.com/example/test/tree/' + 'a'.repeat(40), baseline: { version: 1 } });
  await s.hook(s.input);
  expect(s.client.from).toHaveBeenCalledWith('requirement_source_checkpoints');
  expect(s.query.eq).toHaveBeenCalledWith('site_id', s.run.siteId);
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ baseline: { version: 1 }, run: s.run, baseRef: 'main' }));
  expect(s.client.rpc).toHaveBeenCalledWith('record_requirement_source_checkpoint', expect.objectContaining({
    p_owner: s.input.owner, p_session_id: s.run.sessionId, p_generation: 1, p_baseline: { version: 1 },
    p_result: expect.objectContaining({ state: 'saved' }),
  }));
  expect(s.client.rpc.mock.calls[0][1].p_result).not.toHaveProperty('baseline');
});

it('never publishes when prior receipt storage is unavailable', async () => {
  const s = setup(); s.query.maybeSingle.mockResolvedValue({ data: null, error: new Error('offline') });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try { await s.hook(s.input); expect(checkpoint).not.toHaveBeenCalled(); expect(s.client.rpc).not.toHaveBeenCalled(); }
  finally { warn.mockRestore(); }
});

it('preserves prior baseline after unknown publication and does not claim a successful checkpoint', async () => {
  const s = setup(); checkpoint.mockResolvedValue({ state: 'unknown', reason: 'ref_unconfirmed' });
  await s.hook(s.input);
  expect(s.client.rpc).toHaveBeenCalledWith('record_requirement_source_checkpoint', expect.objectContaining({
    p_baseline: null, p_result: { state: 'unknown', reason: 'ref_unconfirmed' },
  }));
});

it('does no work after execution ownership is lost', async () => {
  const s = setup(); s.input.assertActive.mockRejectedValue(new Error('stale'));
  await expect(s.hook(s.input)).rejects.toThrow('stale');
  expect(checkpoint).not.toHaveBeenCalled(); expect(s.client.from).not.toHaveBeenCalled();
});

it('persists a write-ahead intent before publishing and passes it back after final receipt loss', async () => {
  const s = setup();
  const intent = { parentSha: 'a'.repeat(40), expectedSha: 'b'.repeat(40), createRef: false,
    baseline: { version: 1, commitSha: 'b'.repeat(40) } };
  let storedIntent: unknown;
  const published = jest.fn();
  s.client.rpc.mockImplementation(async (name, args) => {
    if (name === 'prepare_requirement_source_checkpoint') { storedIntent = args.p_intent; return { data: true, error: null }; }
    return { data: false, error: null }; // GitHub succeeded, final DB receipt did not.
  });
  checkpoint.mockImplementation(async input => {
    await input.preparePublication(intent);
    expect(storedIntent).toEqual(intent);
    published();
    return { state: 'saved', sha: intent.expectedSha, baseline: intent.baseline };
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await s.hook(s.input);
    expect(published).toHaveBeenCalledTimes(1);
    s.query.maybeSingle.mockResolvedValue({ data: { baseline: { version: 1 }, pending_publication: storedIntent }, error: null });
    checkpoint.mockResolvedValue({ state: 'unchanged', sha: intent.expectedSha, baseline: intent.baseline });
    await s.hook(s.input);
    expect(checkpoint.mock.calls.at(-1)![0].pendingPublication).toEqual(intent);
  } finally { warn.mockRestore(); }
});

it('does not authorize a ref update when preparing its durable intent fails', async () => {
  const s = setup(); const published = jest.fn();
  s.client.rpc.mockResolvedValue({ data: false, error: null });
  checkpoint.mockImplementation(async input => {
    await input.preparePublication({ parentSha: 'a'.repeat(40), expectedSha: 'b'.repeat(40) });
    published();
  });
  await expect(s.hook(s.input)).rejects.toThrow('Checkpoint publication intent unavailable');
  expect(published).not.toHaveBeenCalled();
  expect(s.client.rpc.mock.calls.map(call => call[0])).toEqual(['prepare_requirement_source_checkpoint']);
});