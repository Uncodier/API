const mockWriteEvidence = jest.fn();
const mockComputeFingerprint = jest.fn();

jest.mock('@/lib/services/requirement-ground-truth', () => ({
  writeEvidence: mockWriteEvidence,
}));
jest.mock(
  '@/app/api/cron/shared/commit/pre-push-build-validation',
  () => ({
    computeApplicationBuildFingerprint: mockComputeFingerprint,
  }),
);
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

import {
  captureSandboxTestFingerprint,
  isSandboxTestCommand,
  persistSandboxTestReceipt,
} from '../sandbox-test-receipt';

describe('sandbox test receipts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteEvidence.mockResolvedValue({});
  });

  it('recognizes supported test runners without treating builds as tests', () => {
    expect(isSandboxTestCommand('npm test -- unit.test.ts')).toBe(true);
    expect(isSandboxTestCommand('npx jest unit.test.ts')).toBe(true);
    expect(isSandboxTestCommand('npm run build')).toBe(false);
  });

  it('captures the strict build fingerprint', async () => {
    mockComputeFingerprint.mockResolvedValue('a'.repeat(64));
    await expect(
      captureSandboxTestFingerprint({} as any),
    ).resolves.toBe('a'.repeat(64));
  });

  it('persists a receipt scoped to step, command, and fingerprint', async () => {
    await persistSandboxTestReceipt({
      sandbox: {} as any,
      requirementId: 'req-1',
      backlogItemId: 'item-1',
      stepId: 'step-1',
      command: 'npm test',
      exitCode: 0,
      output: 'PASS',
      workspaceFingerprint: 'a'.repeat(64),
      ranAfterChanges: true,
    });

    expect(mockWriteEvidence).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: 'req-1',
      itemId: 'item-1',
      requireCanonicalPersistence: true,
      record: expect.objectContaining({
        producer_step_id: 'step-1',
        workspace_fingerprint: 'a'.repeat(64),
        tests: [expect.objectContaining({
          command: 'npm test',
          exit_code: 0,
          ran_after_changes: true,
        })],
      }),
    }));
  });
});
