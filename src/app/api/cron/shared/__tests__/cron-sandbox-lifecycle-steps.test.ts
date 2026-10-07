import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as rejection from '../cron-ownership-rejection';
import { sanitizeRuntimeLog } from '../runtime-log-context';

const mockGetSandboxHandle = jest.fn();
const mockRunCommand = jest.fn();
const mockCaptureFingerprint = jest.fn();
const mockPersistReceipt = jest.fn();
const mockLogEvent = jest.fn();
const mockAssertOwner = jest.fn();
const mockCreateSandbox = jest.fn();
const mockInspectWorkspace = jest.fn();
const mockCurrentBranch = jest.fn();
const mockMissingSnapshot = jest.fn();
const mockWarmStart = jest.fn();
class SandboxAPIError extends Error {
  constructor(public response: { status: number }, public json: { error: { code: string } }) { super('Sandbox API failure'); }
}

const ownershipModule = loadRuntimeModule<typeof import('../cron-execution-ownership')>(
  'src/app/api/cron/shared/cron-execution-ownership.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin: {} },
    './cron-ownership-rejection': rejection,
  },
);
const { CronExecutionOwnershipError } = ownershipModule;

class FatalError extends Error {
  name = 'FatalError';
  fatal = true;
}
const { checkBackgroundCommandStep, createSandboxStep, stopSandboxStep, assertCronExecutionOwnershipStep, extendRunLockStep } =
  loadRuntimeModule<typeof import('../cron-sandbox-lifecycle-steps')>(
    'src/app/api/cron/shared/cron-sandbox-lifecycle-steps.ts', {
      workflow: { FatalError },
      '@vercel/sandbox': { APIError: SandboxAPIError },
      '@/lib/services/sandbox-missing-snapshot': { isMissingSandboxSnapshotError: mockMissingSnapshot },
      '@/lib/services/sandbox-sdk': { getSandboxHandle: mockGetSandboxHandle, sandboxIdentity: () => 'sandbox-1' },
      '@/lib/services/sandbox-service': { SandboxService: { runCommandInSandbox: mockRunCommand, createRequirementSandbox: mockCreateSandbox, getCurrentBranch: mockCurrentBranch, WORK_DIR: '/vercel/sandbox' } },
      '@/lib/services/sandbox-constants': { requirementSandboxName: () => 'sandbox-name' },
      '@/lib/database/supabase-client': { supabaseAdmin: {} },
      '@/lib/services/sandbox-recovery': { inspectSandboxWorkspace: mockInspectWorkspace },
      '@/lib/services/sandbox-on-resume': { warmStartNamedSandbox: mockWarmStart },
      './cron-run-lock': { releaseRunLock: jest.fn(), extendRunLock: jest.fn(), CRON_RUN_LOCK_TTL_MS: 60_000 },
      './cron-execution-ownership': { ...ownershipModule, assertCronExecutionOwnership: mockAssertOwner },
      './runtime-log-context': { sanitizeRuntimeLog },
      '@/lib/services/cron-audit-log': { CronInfraEvent: { STEP_STATUS: 'step_status', SANDBOX_STOP: 'sandbox_stop' }, logCronInfrastructureEvent: mockLogEvent },
      '@/app/api/agents/tools/sandbox/sandbox-test-receipt': {
        captureSandboxTestFingerprint: mockCaptureFingerprint,
        isSandboxTestCommand: (command: string) => command === 'npm test',
        persistSandboxTestReceipt: mockPersistReceipt,
      },
    },
  );

describe('checkBackgroundCommandStep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptureFingerprint.mockResolvedValue('a'.repeat(64));
    mockPersistReceipt.mockResolvedValue(undefined);
    mockLogEvent.mockResolvedValue(undefined);
  });

  it('persists completed background test evidence before the next turn', async () => {
    const sandbox = {
      getCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
      fs: {
        readFile: jest.fn(async (path: string) =>
          path.endsWith('.command') ? 'npm test' : 'a'.repeat(64)
        ),
      },
    };
    mockGetSandboxHandle.mockResolvedValue(sandbox);
    mockRunCommand.mockResolvedValue({ stdout: 'PASS suite' });

    await expect(checkBackgroundCommandStep(
      'sandbox-1',
      'command-1',
      '/tmp/test.log',
      {
        siteId: 'site-1',
        requirementId: 'req-1',
        planId: 'plan-1',
        stepId: 'step-1',
      },
      'item-1',
    )).resolves.toEqual({
      isRunning: false,
      output: 'PASS suite',
      exitCode: 0,
    });
    expect(mockPersistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: 'req-1',
      backlogItemId: 'item-1',
      stepId: 'step-1',
      command: 'npm test',
      exitCode: 0,
      ranAfterChanges: true,
    }));
  });
});

describe('durable lifecycle execution fencing', () => {
  const ownership = { requirementId: 'req', runId: 'original', executionGeneration: 7, allowTerminal: true };
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertOwner.mockResolvedValue(undefined);
  });

  it('does not attach/stop a newer sandbox after ownership is revoked', async () => {
    mockAssertOwner.mockRejectedValueOnce(new CronExecutionOwnershipError('run_owner_changed'));
    await expect(stopSandboxStep('sandbox', undefined, ownership)).rejects.toThrow('run_owner_changed');
    expect(mockGetSandboxHandle).not.toHaveBeenCalled();
  });

  it('does not look up, resume, or create a sandbox for stale durable create retries', async () => {
    mockAssertOwner.mockRejectedValueOnce(new CronExecutionOwnershipError('run_owner_changed'));
    await expect(createSandboxStep('req', 'applications', 'title', undefined, ownership))
      .rejects.toThrow('run_owner_changed');
    expect(mockGetSandboxHandle).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('does not resume a sandbox if ownership changes during get', async () => {
    const resume = jest.fn();
    mockGetSandboxHandle.mockResolvedValue({ resume });
    mockAssertOwner.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new CronExecutionOwnershipError('run_owner_changed'));
    await expect(createSandboxStep('req', 'applications', 'title', undefined, ownership))
      .rejects.toThrow('run_owner_changed');
    expect(resume).not.toHaveBeenCalled();
  });

  it('checks again after a potentially slow sandbox lookup without retrying lost ownership', async () => {
    const stop = jest.fn();
    mockGetSandboxHandle.mockResolvedValue({ stop });
    mockAssertOwner.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new CronExecutionOwnershipError('run_owner_changed'));
    await expect(stopSandboxStep('sandbox', undefined, ownership)).rejects.toThrow('run_owner_changed');
    expect(stop).not.toHaveBeenCalled();
    expect(mockGetSandboxHandle).toHaveBeenCalledTimes(1);
  });

  it('delegates guards without automatic stale retries and rejects missing extension identity', async () => {
    await assertCronExecutionOwnershipStep(ownership);
    expect(mockAssertOwner).toHaveBeenCalledWith(ownership);
    expect(assertCronExecutionOwnershipStep.maxRetries).toBe(0);
    await expect(extendRunLockStep('req', undefined)).rejects.toThrow('missing_execution_identity');
  });

  it.each(['execution_not_runnable', 'run_owner_changed', 'execution_generation_changed', 'ownership_check_unavailable'])(
    'preserves %s through the durable fatal path rather than retry starvation', async reason => {
      mockAssertOwner.mockRejectedValueOnce(new CronExecutionOwnershipError(reason));
      await expect(assertCronExecutionOwnershipStep(ownership)).rejects.toMatchObject({
        name: 'FatalError', fatal: true,
        message: `Cron execution ownership rejected (${reason})`,
        stack: undefined,
      });
      expect(mockAssertOwner).toHaveBeenCalledTimes(1);
    },
  );
});

describe('sandbox shutdown proof', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertOwner.mockResolvedValue(undefined);
    mockLogEvent.mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('returns verified shutdown only after the stop call succeeds', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);
    mockGetSandboxHandle.mockResolvedValue({ stop });
    await expect(stopSandboxStep('sandbox')).resolves.toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({ event: 'sandbox_stop' }));
  });

  it.each([404, 410])('recognizes definitive sandbox absence %s without claiming a retry', async status => {
    mockGetSandboxHandle.mockRejectedValue({ status, message: 'Sandbox absent' });
    await expect(stopSandboxStep('sandbox')).resolves.toEqual({ stopped: true });
    expect(mockGetSandboxHandle).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({ message: 'Sandbox already absent (sandbox)' }));
  });

  it('returns false after exhausted failures and retains zombie logging', async () => {
    const stop = jest.fn().mockRejectedValue(new Error('Transport unavailable'));
    mockGetSandboxHandle.mockResolvedValue({ stop });
    const result = stopSandboxStep('sandbox');
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual({ stopped: false });
    expect(stop).toHaveBeenCalledTimes(3);
    expect(mockLogEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({ level: 'warn', message: expect.stringContaining('ZOMBIE ALERT') }));
  });

  it('returns true when a bounded stop retry succeeds', async () => {
    const stop = jest.fn().mockRejectedValueOnce(new Error('Transport unavailable')).mockResolvedValue(undefined);
    mockGetSandboxHandle.mockResolvedValue({ stop });
    const result = stopSandboxStep('sandbox');
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not treat a missing stop endpoint as proof that the located sandbox is absent', async () => {
    const stop = jest.fn().mockRejectedValue({ status: 404, message: 'Endpoint unavailable' });
    mockGetSandboxHandle.mockResolvedValue({ stop });
    const result = stopSandboxStep('sandbox');
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual({ stopped: false });
    expect(stop).toHaveBeenCalledTimes(3);
  });
});

describe('sandbox reuse admission', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAssertOwner.mockResolvedValue(undefined);
    mockMissingSnapshot.mockReturnValue(false);
    mockInspectWorkspace.mockResolvedValue({ ok: true, fatal: false });
    mockCurrentBranch.mockResolvedValue('feature/req');
    mockWarmStart.mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('reuses a healthy sandbox without provisioning', async () => {
    mockGetSandboxHandle.mockResolvedValue({ resume: jest.fn().mockResolvedValue(undefined) });
    await expect(createSandboxStep('req', 'applications', '')).resolves.toMatchObject({ sandboxId: 'sandbox-1' });
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    expect(mockWarmStart).toHaveBeenCalledWith(expect.anything(), 'req', 'applications', { syncToOrigin: false });
  });

  it.each(['auth denied', 'transport timeout', 'unknown 410'])(
    'propagates %s rather than interpreting it as absence', async message => {
      const error = new Error(message);
      mockGetSandboxHandle.mockRejectedValue(error);
      await expect(createSandboxStep('req', 'applications', '')).rejects.toBe(error);
      expect(mockCreateSandbox).not.toHaveBeenCalled();
    },
  );

  it.each([[404, 'not_found'], [410, 'snapshot_not_found']])(
    'passes definitive %s/%s to named provisioning', async (status, code) => {
      mockGetSandboxHandle.mockRejectedValue(new SandboxAPIError({ status: Number(status) }, { error: { code: String(code) } }));
      mockCreateSandbox.mockResolvedValue({ sandbox: {}, branchName: 'feature/req', workDir: '/vercel/sandbox', isNewBranch: false, instanceType: 'applications' });
      await createSandboxStep('req', 'applications', '');
      expect(mockCreateSandbox).toHaveBeenCalledTimes(1);
    },
  );

  it('passes legacy missing-snapshot errors to guarded recovery', async () => {
    mockGetSandboxHandle.mockRejectedValue(new Error('missing snapshot'));
    mockMissingSnapshot.mockReturnValue(true);
    mockCreateSandbox.mockResolvedValue({ sandbox: {}, branchName: 'feature/req', workDir: '/vercel/sandbox', isNewBranch: false, instanceType: 'applications' });
    await createSandboxStep('req', 'applications', '');
    expect(mockCreateSandbox).toHaveBeenCalledTimes(1);
  });

  it('preserves a sandbox whose workspace layout requires repair', async () => {
    mockGetSandboxHandle.mockResolvedValue({});
    mockInspectWorkspace.mockResolvedValue({ ok: false, fatal: true, reason: 'nested layout' });
    await expect(createSandboxStep('req', 'applications', '')).rejects.toThrow('workspace requires repair');
    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });

  it('preserves the VM when branch inspection fails', async () => {
    mockGetSandboxHandle.mockResolvedValue({});
    mockCurrentBranch.mockRejectedValue(new Error('git unavailable'));
    await expect(createSandboxStep('req', 'applications', '')).rejects.toThrow('git unavailable');
    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });
});
