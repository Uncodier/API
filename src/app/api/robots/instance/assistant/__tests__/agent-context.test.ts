import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

function fixture() {
  const find = jest.fn(async (site: string): Promise<{ agentId: string; userId: string } | null> => ({ agentId: `agent-${site}`, userId: 'owner' }));
  const memories = jest.fn(async (agentId: string, userId: string) => `${agentId}:${userId}`);
  const prompt = jest.fn((id: string) => id);
  const selectAgent = jest.fn(async (id: string): Promise<{ data: { id: string } | null; error: Error | null }> => ({ data: { id }, error: null }));
  const from = jest.fn(() => {
    let id: string;
    const query = { select: () => query, eq: (column: string, value: string) => {
      if (column === 'id') id = value;
      return query;
    }, single: () => selectAgent(id) };
    return query;
  });
  const api = loadRuntimeModule<typeof import('../utils')>('src/app/api/robots/instance/assistant/utils.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin: { from } }, './assistant-tools': {},
    '@/lib/helpers/agent-finder': { findGrowthRobotAgent: find },
    '@/lib/services/agent-memory-tools-service': { getContextMemories: memories },
    '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder': { BackgroundBuilder: { buildAgentPrompt: prompt } },
    '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher': { DataFetcher: { getSiteInfo: async () => ({}), getActiveCampaigns: async () => [] } },
    '@/lib/timezone': { resolveClientTimezone: async () => 'UTC' },
  });
  return { api, find, memories, from, selectAgent, prompt };
}

it('shares only the current request’s site selection; memories are read as the caller, not the agent owner', async () => {
  const { api, find, memories } = fixture();
  const results = await Promise.all(['a', 'b', 'a'].map((site, i) => api.loadAssistantAgentContext(site, `user-${i}`, `instance-${i}`)));
  expect(find.mock.calls).toEqual([['a'], ['b'], ['a']]);
  for (const [i, site] of ['a', 'b', 'a'].entries()) {
    expect(memories).toHaveBeenCalledWith(`agent-${site}`, `user-${i}`, { instance_id: `instance-${i}`, limit: 15 });
    expect(results[i]).toEqual({ agentId: `agent-${site}`, background: `agent-${site}`, memoriesContext: `agent-${site}:user-${i}` });
  }
});

it('does not retry a missing selection or look up unscoped memories', async () => {
  const { api, find, memories, from } = fixture();
  find.mockResolvedValueOnce(null);
  expect(await api.loadAssistantAgentContext('site', 'user', 'instance')).toEqual({ background: '', memoriesContext: '' });
  expect(find).toHaveBeenCalledTimes(1);
  expect(from).not.toHaveBeenCalled();
  expect(memories).not.toHaveBeenCalled();
  expect(await api.fetchMemoriesContext('site', undefined)).toBe('');
  expect(find).toHaveBeenCalledTimes(1);
});

it.each([null, new Error('selection unavailable')])('does not load memories when the active site agent cannot be confirmed', async error => {
  const { api, find, selectAgent, memories } = fixture();
  selectAgent.mockResolvedValueOnce({ data: null, error });
  expect(await api.loadAssistantAgentContext('site', 'user', 'instance')).toEqual({ background: '', memoriesContext: '' });
  expect(find).toHaveBeenCalledTimes(1);
  expect(memories).not.toHaveBeenCalled();
});

it('keeps memories from the confirmed agent if optional background formatting fails', async () => {
  const { api, prompt, memories } = fixture();
  prompt.mockImplementationOnce(() => { throw new Error('formatting unavailable'); });
  expect(await api.loadAssistantAgentContext('site', 'user', 'instance')).toEqual({ background: '', memoriesContext: 'agent-site:user' });
  expect(memories).toHaveBeenCalledTimes(1);
});

it('shares neither identity nor actor memories across concurrent requests, even within one site', async () => {
  const { api, find, memories } = fixture();
  const count = 40;
  // Let every actor reach the memory read, then finish in the reverse order.
  const releases: Array<() => void> = [];
  let ready!: () => void;
  const allReading = new Promise<void>(resolve => { ready = resolve; });
  memories.mockImplementation((agentId, userId) => new Promise(resolve => {
    releases.push(() => resolve(`${agentId}:${userId}`));
    if (releases.length === count) ready();
  }));
  const calls = Array.from({ length: count }, (_, i) => api.loadAssistantAgentContext(`site-${i % 2}`, `user-${i}`, `instance-${i}`));
  await allReading;
  releases.reverse().forEach(release => release());
  const contexts = await Promise.all(calls);
  expect(find).toHaveBeenCalledTimes(count);
  contexts.forEach((context, i) => {
    const id = `agent-site-${i % 2}`;
    expect(context).toEqual({ agentId: id, background: id, memoriesContext: `${id}:user-${i}` });
    expect(memories).toHaveBeenCalledWith(id, `user-${i}`, { instance_id: `instance-${i}`, limit: 15 });
  });
});