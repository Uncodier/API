const mockGetSandboxHandle = jest.fn();
const mockRunCommand = jest.fn();
const mockCaptureFingerprint = jest.fn();
const mockPersistReceipt = jest.fn();
const mockLogEvent = jest.fn();
const mockAssertOwner = jest.fn();

jest.mock('@/lib/services/sandbox-sdk', () => ({
  getSandboxHandle: mockGetSandboxHandle,
  sandboxIdentity: jest.fn(() => 'sandbox-1'),
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    runCommandInSandbox: mockRunCommand,
  },
}));
jest.mock('@/lib/services/sandbox-constants', () => ({
  requirementSandboxName: jest.fn(() => 'sandbox-name'),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));
jest.mock('@/lib/services/sandbox-recovery', () => ({
  inspectSandboxWorkspace: jest.fn(),
}));
jest.mock('@/lib/services/sandbox-on-resume', () => ({
  warmStartNamedSandbox: jest.fn(),
}));
jest.mock('../cron-run-lock', () => ({
  releaseRunLock: jest.fn(),
  extendRunLock: jest.fn(),
  CRON_RUN_LOCK_TTL_MS: 60_000,
}));
jest.mock('../cron-execution-ownership', () => ({
  ...jest.requireActual('../cron-execution-ownership'),
  assertCronExecutionOwnership: mockAssertOwner,
}));
jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { STEP_STATUS: 'step_status' },
  logCronInfrastructureEvent: mockLogEvent,
}));
jest.mock(
  '@/app/api/agents/tools/sandbox/sandbox-test-receipt',
  () => ({
    captureSandboxTestFingerprint: mockCaptureFingerprint,
    isSandboxTestCommand: (command: string) => command === 'npm test',
    persistSandboxTestReceipt: mockPersistReceipt,
  }),
);

import { checkBackgroundCommandStep, createSandboxStep, stopSandboxStep, assertCronExecutionOwnershipStep, extendRunLockStep } from '../cron-sandbox-lifecycle-steps';
import { CronExecutionOwnershipError } from '../cron-execution-ownership';

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
});
