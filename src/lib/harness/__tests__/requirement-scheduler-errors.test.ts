const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
import { claimRequirementRun } from '../requirement-scheduler';

beforeEach(() => mockRpc.mockReset());

const observer = () => ({ claimStages: jest.fn(), claimFailure: jest.fn() });
function timedReply(reply: unknown) {
  const setHeader = jest.fn().mockResolvedValue(reply);
  mockRpc.mockReturnValue({ setHeader });
  return setHeader;
}

it.each([
  ['57014', 'database timeout'], ['55P03', 'database contention'],
  ['40P01', 'database contention'], ['42501', 'database request failed'],
  ['08006', 'database request failed'], ['', 'database request failed'],
])('classifies %s without alleging a missing migration or exposing database bodies', async (code, category) => {
  const observation = observer();
  timedReply({ error: { code, message: 'private tenant SQL', details: 'private details' } });
  await expect(claimRequirementRun([], 8, [], observation)).rejects.toThrow(`Agent cron admission unavailable (${category})`);
  expect(observation.claimFailure.mock.calls).toEqual([[category.replace('database ', '').replace(' ', '_')]]);
  expect(observation.claimStages).not.toHaveBeenCalled();
  expect(mockRpc).toHaveBeenCalledTimes(1);
});

it.each(['PGRST202', '42883'])('asks to verify installation/cache only for %s', async code => {
  const observation = observer();
  timedReply({ error: { code, message: 'private tenant SQL' } });
  await expect(claimRequirementRun([], 8, [], observation)).rejects.toThrow('Agent cron admission RPC unavailable; verify installed functions and schema cache');
  expect(observation.claimFailure.mock.calls).toEqual([['rpc_unavailable']]);
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

it.each([null, { state: 'capacity_full' }, { state: 'claimed', run: { requirementId: 'private' } }])(
  'preserves a legacy or timed result in one atomic call', async claim => {
    const observation = observer();
    const stage_ms = { economic_pause: 100, pending_commands: 10, reservation: 1 };
    timedReply({ data: claim });
    expect(await claimRequirementRun([], 8, [], observation)).toEqual(claim);
    expect(observation.claimStages).not.toHaveBeenCalled();
    const header = timedReply({ data: { claim, stage_ms } });
    expect(await claimRequirementRun([], 8, [], observation)).toEqual(claim);
    expect(header.mock.calls).toEqual([['x-claim-timings', '1']]);
    expect(observation.claimStages.mock.calls).toEqual([[stage_ms]]);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  },
);
