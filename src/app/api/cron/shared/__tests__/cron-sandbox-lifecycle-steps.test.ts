const mockGetSandboxHandle = jest.fn();
const mockRunCommand = jest.fn();
const mockCaptureFingerprint = jest.fn();
const mockPersistReceipt = jest.fn();
const mockLogEvent = jest.fn();

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

import { checkBackgroundCommandStep } from '../cron-sandbox-lifecycle-steps';

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
