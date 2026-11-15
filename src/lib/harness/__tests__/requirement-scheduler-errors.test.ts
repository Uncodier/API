const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
import { claimRequirementRun } from '../requirement-scheduler';

beforeEach(() => mockRpc.mockReset());

it.each([
  ['57014', 'database timeout'], ['55P03', 'database contention'],
  ['40P01', 'database contention'], ['42501', 'database request failed'],
  ['08006', 'database request failed'], ['', 'database request failed'],
])('classifies %s without alleging a missing migration or exposing database bodies', async (code, category) => {
  mockRpc.mockResolvedValue({ error: { code, message: 'private tenant SQL', details: 'private details' } });
  await expect(claimRequirementRun([], 8, [])).rejects.toThrow(`Agent cron admission unavailable (${category})`);
  expect(mockRpc).toHaveBeenCalledTimes(1);
});

it.each(['PGRST202', '42883'])('asks to verify installation/cache only for %s', async code => {
  mockRpc.mockResolvedValue({ error: { code, message: 'private tenant SQL' } });
  await expect(claimRequirementRun([], 8, [])).rejects.toThrow('Agent cron admission RPC unavailable; verify installed functions and schema cache');
  expect(mockRpc).toHaveBeenCalledTimes(1);
});

it('preserves capacity and null results and claim parameters without write retries', async () => {
  mockRpc.mockResolvedValueOnce({ data: { state: 'capacity_full' } }).mockResolvedValueOnce({ data: null });
  expect(await claimRequirementRun(['excluded'], 8, ['scheduled'])).toEqual({ state: 'capacity_full' });
  expect(await claimRequirementRun([], 8, [])).toBeNull();
  expect(mockRpc).toHaveBeenNthCalledWith(1, 'claim_agent_requirement_run', {
    p_excluded_ids: ['excluded'], p_max_concurrent: 8, p_ttl_seconds: 300, p_scheduled_ids: ['scheduled'],
  });
});
