import { randomBytes } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { collectListedSandboxes, listHousekeepingSandboxes } from '../sandbox-housekeeping-list';
jest.mock('@vercel/sandbox', () => ({ Sandbox: { list: jest.fn() } }));

it('retains SDK v3 name-only entries and legacy entries without deduplicating by undefined', () => {
  expect(collectListedSandboxes({sandboxes:[{name:'one'},{name:'two'},{id:'legacy'},{id:'legacy-id',name:'named'},{}]})).toEqual([
    {id:'one',name:'one'}, {id:'two',name:'two'}, {id:'legacy'}, {id:'named',name:'named'},
  ]);
});
it('uses SDK v3 string cursors across pages and deduplicates by actual name', async () => {
  const credentials={token:randomBytes(24).toString('hex'),teamId:'synthetic-team',projectId:'synthetic-project'};
  jest.mocked(Sandbox.list).mockResolvedValueOnce({sandboxes:[{name:'one'},{name:'two'}],pagination:{next:'cursor'}} as never)
    .mockResolvedValueOnce({sandboxes:[{name:'one'},{name:'three'}],pagination:{next:null}} as never);
  expect((await listHousekeepingSandboxes(credentials)).map(row=>row.id)).toEqual(['one','two','three']);
  expect(Sandbox.list).toHaveBeenLastCalledWith({...credentials,limit:50,cursor:'cursor'});
});
it('never exceeds the current API page cap, including more than 100 resources', async () => {
  jest.mocked(Sandbox.list).mockReset().mockImplementation(async params => {
    const p = params as { limit?: number; cursor?: string };
    if ((p.limit ?? 0) > 50) throw new Error('API rejects limit > 50');
    const page = p.cursor ? Number(p.cursor) : 0;
    return { sandboxes: Array.from({ length: page === 2 ? 5 : 50 }, (_, i) => ({ name: `sandbox-${page * 50 + i}` })),
      pagination: { next: page < 2 ? String(page + 1) : null } } as never;
  });
  const rows = await listHousekeepingSandboxes({});
  expect(rows).toHaveLength(105);
  expect(Sandbox.list).toHaveBeenCalledTimes(3);
  for (const [params] of jest.mocked(Sandbox.list).mock.calls) {
    expect(params).toMatchObject({ limit: 50 });
    expect(params).not.toHaveProperty('token');
    expect(params).not.toHaveProperty('teamId');
    expect(params).not.toHaveProperty('projectId');
  }
});