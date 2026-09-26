import { assertCronExecutionOwnership, CronExecutionOwnershipError, withCronExecutionOwnership } from '../cron-execution-ownership';
import { extendRunLock, releaseRunLock } from '../cron-run-lock';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: jest.fn(), from: jest.fn() },
  getSupabaseServiceRoleUrl: jest.fn(),
}));

const ownership = { requirementId: 'req', runId: 'run-original', executionGeneration: 7 };
const rpc = supabaseAdmin.rpc as jest.Mock;
let query: any;
beforeEach(() => {
  jest.resetAllMocks();
  rpc.mockResolvedValue({ data: { current: true }, error: null });
  query = { update: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    then: (resolve: any) => resolve({ data: [{ id: 'req' }], error: null }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
});

it('asserts original owner and generation, never allowing inactive/terminal work by default', async () => {
  await assertCronExecutionOwnership(ownership);
  expect(rpc).toHaveBeenCalledWith('assert_requirement_cron_execution_owner', {
    p_requirement_id: 'req', p_run_id: 'run-original', p_expected_execution_generation: 7,
    p_allow_inactive: false, p_allow_terminal: false,
  });
});

it.each(['run_owner_changed', 'execution_generation_changed', 'lease_expired', 'lease_inactive', 'execution_not_runnable'])(
  'rejects %s rather than silently running', async (reason) => {
    rpc.mockResolvedValue({ data: { current: false, reason }, error: null });
    await expect(assertCronExecutionOwnership(ownership)).rejects.toThrow(reason);
  });

it.each([null, {}, { current: 1 }])('fails closed for malformed ownership response %j', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(assertCronExecutionOwnership(ownership)).rejects.toThrow(CronExecutionOwnershipError);
});

it('fails closed with a deployment instruction on an older schema', async () => {
  rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing RPC' } });
  await expect(assertCronExecutionOwnership(ownership)).rejects.toThrow('Deploy 20260926070000');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('fails closed on transport errors and missing execution identity', async () => {
  rpc.mockRejectedValue(new Error('network unavailable'));
  await expect(assertCronExecutionOwnership(ownership)).rejects.toThrow('ownership_check_unavailable');
  rpc.mockClear();
  await expect(assertCronExecutionOwnership({ ...ownership, runId: undefined })).rejects.toThrow('missing_execution_identity');
  expect(rpc).not.toHaveBeenCalled();
});

it('revalidates immediately at actual tool dispatch after a delayed assistant request', async () => {
  await assertCronExecutionOwnership(ownership);
  const effect = jest.fn();
  const tools = withCronExecutionOwnership([{ name: 'write', execute: effect }], ownership);
  rpc.mockResolvedValue({ data: { current: false, reason: 'run_owner_changed' }, error: null });
  await expect(tools[0].execute({ path: 'file' })).rejects.toThrow('run_owner_changed');
  expect(effect).not.toHaveBeenCalled();
});

it('preserves tool receiver, arguments and result for a valid dispatch', async () => {
  const tool = { name: 'write', execute: jest.fn(function(this: any, value) { return [this.name, value]; }) };
  const wrapped = withCronExecutionOwnership([tool], ownership);
  expect(await wrapped[0].execute('arg')).toEqual(['write', 'arg']);
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('extends only an unexpired matching owner and requires returned rows', async () => {
  await extendRunLock('req', 'run-original');
  expect(query.eq).toHaveBeenCalledWith('cron_lock_run_id', 'run-original');
  expect(query.gt).toHaveBeenCalledWith('cron_lock_expires_at', expect.any(String));
  expect(query.select).toHaveBeenCalledWith('id');
  query.then = (resolve: any) => resolve({ data: [], error: null });
  await expect(extendRunLock('req', 'old-run')).rejects.toThrow('lease_lost');
});

it('does not swallow extension database errors or rejected requests', async () => {
  query.then = (resolve: any) => resolve({ data: null, error: { message: 'database denied' } });
  await expect(extendRunLock('req', 'run-original')).rejects.toThrow('lease_extend_unavailable');
  query.then = (_: any, reject: any) => reject(new Error('network down'));
  await expect(extendRunLock('req', 'run-original')).rejects.toThrow('network down');
});

it('late releases keep the original run predicate so they cannot clear a new owner', async () => {
  await releaseRunLock('req', 'run-original');
  expect(query.eq).toHaveBeenCalledWith('cron_lock_run_id', 'run-original');
});