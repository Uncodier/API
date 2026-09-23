const mockCaptureFingerprint = jest.fn();
const mockValidateLayout = jest.fn();
const mockRecordBuild = jest.fn();

jest.mock('../vercel-npm-repo-guard', () => ({
  validateNpmRepoForVercelDeploy: mockValidateLayout,
}));
jest.mock('../commit/pre-push-build-validation', () => ({
  computeApplicationBuildFingerprint: mockCaptureFingerprint,
  recordSuccessfulApplicationBuild: mockRecordBuild,
}));
jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: {
    GATE_BUILD: 'gate_build',
    STEP_STATUS: 'step_status',
  },
  logCronInfrastructureEvent: jest.fn(),
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

import { runLocalGateValidation } from '../step-local-validation';

function commandResult(exitCode: number, output = '') {
  return {
    exitCode,
    stdout: jest.fn().mockResolvedValue(output),
    stderr: jest.fn().mockResolvedValue(''),
  };
}

describe('local gate validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateLayout.mockResolvedValue(null);
    mockRecordBuild.mockResolvedValue(undefined);
  });

  it('reuses unchanged build and test receipts without executing commands', async () => {
    const fingerprint = 'a'.repeat(40);
    mockCaptureFingerprint.mockResolvedValue(fingerprint);
    const sandbox = { runCommand: jest.fn() };

    await expect(runLocalGateValidation({
      sandbox: sandbox as any,
      stepId: 'step-1',
      stepOrder: 1,
      testCommand: 'npm test',
      gitRepoKind: 'applications',
      workspaceFingerprint: fingerprint,
      reusableValidation: {
        buildPassed: true,
        tests: {
          ok: true,
          tests: [{
            command: 'npm test',
            exit_code: 0,
            output_tail: 'PASS',
            ran_after_changes: true,
            captured_at: '2026-09-22T12:00:00.000Z',
            step_id: 'step-1',
            workspace_fingerprint: fingerprint,
          }],
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      signals: {
        build: { ok: true },
        tests: { ok: true },
        workspace_fingerprint: fingerprint,
      },
    });
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('rejects a passing test receipt when the test changes product files', async () => {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);
    mockCaptureFingerprint
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0, 'PASS')),
    };

    const result = await runLocalGateValidation({
      sandbox: sandbox as any,
      stepId: 'step-1',
      stepOrder: 1,
      testCommand: 'npm test',
      gitRepoKind: 'applications',
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed product files'),
      signals: {
        tests: {
          ok: false,
          tests: [expect.objectContaining({
            exit_code: 0,
            ran_after_changes: false,
          })],
        },
      },
    });
  });

  it('fails closed when the post-test fingerprint is unavailable', async () => {
    mockCaptureFingerprint
      .mockResolvedValueOnce('a'.repeat(40))
      .mockResolvedValueOnce(null);
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0, 'PASS')),
    };

    await expect(runLocalGateValidation({
      sandbox: sandbox as any,
      stepId: 'step-1',
      stepOrder: 1,
      testCommand: 'npm test',
      gitRepoKind: 'applications',
    })).resolves.toMatchObject({
      ok: false,
      infrastructureFailure: true,
      error: expect.stringContaining(
        'workspace fingerprint could not be verified',
      ),
      signals: {
        tests: {
          ok: false,
          tests: [expect.objectContaining({
            ran_after_changes: false,
          })],
        },
      },
    });
  });
});
