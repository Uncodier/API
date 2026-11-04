import { randomUUID } from 'node:crypto';
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
import { retireMissingWorkspace } from '../retire-missing-workspace';

beforeEach(() => jest.resetAllMocks());
it('passes only trusted CAS identity and requires a confirmed receipt', async () => {
  const input = { sessionId: randomUUID(), siteId: randomUUID(), owner: randomUUID(), version: 3, resource: 'req-old' };
  rpc.mockResolvedValue({ data: { version: 4 }, error: null });
  await retireMissingWorkspace(input);
  expect(rpc).toHaveBeenCalledWith('retire_missing_harness_workspace', {
    p_id: input.sessionId, p_site_id: input.siteId, p_owner: input.owner, p_expected_version: 3, p_resource: 'req-old',
  });
  for (const result of [{ data: null }, { data: false }, { data: null, error: { message: 'private database detail' } }]) {
    rpc.mockResolvedValue(result);
    await expect(retireMissingWorkspace(input)).rejects.toThrow('Missing workspace reference could not be retired safely.');
  }
});