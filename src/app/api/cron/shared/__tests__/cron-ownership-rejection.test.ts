import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as rejection from '../cron-ownership-rejection';

const rpc = jest.fn();
const { assertCronExecutionOwnership } = loadRuntimeModule<typeof import('../cron-execution-ownership')>(
  'src/app/api/cron/shared/cron-execution-ownership.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin: { rpc } },
    './cron-ownership-rejection': rejection,
  },
);
const ownership = { requirementId: 'req', runId: 'run-original', executionGeneration: 7 };

describe('bounded durable ownership rejection diagnostics', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs the exact rejected identity and reason once without a raw response or stack', async () => {
    rpc.mockResolvedValue({ data: { current: false, reason: 'execution_not_runnable', metadata: 'private' }, error: null });
    await expect(assertCronExecutionOwnership(ownership)).rejects.toThrow('execution_not_runnable');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[CronOwnership] Execution rejected', {
      event: 'cron_execution_ownership_rejected', ...ownership,
      allowInactive: false, allowTerminal: false, reason: 'execution_not_runnable',
    });
  });

  it.each(['run_owner_changed', 'execution_generation_changed', 'lease_expired'])(
    'does not relax %s when cleanup allows terminal execution', async reason => {
      rpc.mockResolvedValue({ data: { current: false, reason }, error: null });
      await expect(assertCronExecutionOwnership({ ...ownership, allowTerminal: true })).rejects.toThrow(reason);
      expect(rpc).toHaveBeenCalledWith('assert_requirement_cron_execution_owner', {
        p_requirement_id: 'req', p_run_id: 'run-original', p_expected_execution_generation: 7,
        p_allow_inactive: false, p_allow_terminal: true,
      });
    },
  );

  it('keeps outage detail and code bounded and redacted in both logs and fatal message', async () => {
    rpc.mockResolvedValue({ data: null, error: {
      code: 'PGRST202', message: 'password=private; Bearer token123; ' + 'x'.repeat(15000),
    } });
    let message = '';
    try { await assertCronExecutionOwnership(ownership); } catch (error) { message = (error as Error).message; }
    const log = (console.warn as jest.Mock).mock.calls[0][1];
    expect(log).toMatchObject({ reason: 'ownership_check_unavailable', code: 'PGRST202' });
    expect(log.detail.length).toBeLessThanOrEqual(1200);
    expect(JSON.stringify(log).length).toBeLessThan(1800);
    expect(`${message}${JSON.stringify(log)}`).not.toMatch(/private|token123|stack/);
    expect(message).toContain('ownership_check_unavailable');
    expect(message.length).toBeLessThan(1400);
  });

  it.each([{}, 'x'.repeat(1000), 'authorization=secret'])('fails closed on malformed reasons %j', async reason => {
    rpc.mockResolvedValue({ data: { current: false, reason }, error: null });
    await expect(assertCronExecutionOwnership(ownership)).rejects.toThrow('ownership_not_confirmed');
    expect(console.warn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'ownership_not_confirmed' }));
  });

  it('recognizes only the exact serialized rejection, not ambiguous retry wrappers or embedded product text', () => {
    expect(rejection.cronOwnershipRejectionReason(new Error('Cron execution ownership rejected (execution_not_runnable)')))
      .toBe('execution_not_runnable');
    expect(rejection.cronOwnershipRejectionReason({ name: 'FatalError', message: 'Cron execution ownership rejected (execution_not_runnable)' }))
      .toBe('execution_not_runnable');
    expect(rejection.cronOwnershipRejectionReason(new Error('Step "assertCronExecutionOwnershipStep" exceeded max retries (0 retries)')))
      .toBeUndefined();
    expect(rejection.cronOwnershipRejectionReason(new Error('Product failed: Cron execution ownership rejected (execution_not_runnable)')))
      .toBeUndefined();
  });
});