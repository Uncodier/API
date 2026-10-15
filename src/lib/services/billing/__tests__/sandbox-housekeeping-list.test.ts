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
  expect(Sandbox.list).toHaveBeenLastCalledWith({...credentials,limit:100,cursor:'cursor'});
});