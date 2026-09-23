import {
  selectReusableGateValidation,
  shouldResumeGateFromEvidence,
} from '../gate-validation-cache';
import type { EvidenceRecord } from '@/lib/services/requirement-evidence-types';

const FINGERPRINT = 'a'.repeat(40);

function evidence(
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    schema_version: 1,
    item_id: 'item-1',
    producer_step_id: 'step-1',
    workspace_fingerprint: FINGERPRINT,
    captured_at: '2026-09-22T12:00:00.000Z',
    build: {
      command: 'npm run build',
      exit_code: 0,
      duration_ms: 1,
    },
    tests: [{
      command: 'npm test',
      exit_code: 0,
      output_tail: 'PASS',
      ran_after_changes: true,
      step_id: 'step-1',
      workspace_fingerprint: FINGERPRINT,
    }],
    critic_passes: 0,
    ...overrides,
  };
}

describe('gate validation cache', () => {
  it('reuses build and test receipts for the exact step and workspace', () => {
    expect(selectReusableGateValidation({
      evidence: evidence(),
      stepId: 'step-1',
      workspaceFingerprint: FINGERPRINT,
      testCommand: 'npm test',
    })).toEqual({
      buildPassed: true,
      tests: {
        ok: true,
        tests: [expect.objectContaining({ command: 'npm test' })],
      },
    });
  });

  it('invalidates the cache when product files or the command change', () => {
    expect(selectReusableGateValidation({
      evidence: evidence(),
      stepId: 'step-1',
      workspaceFingerprint: 'b'.repeat(40),
      testCommand: 'npm test',
    })).toBeUndefined();
    expect(selectReusableGateValidation({
      evidence: evidence(),
      stepId: 'step-1',
      workspaceFingerprint: FINGERPRINT,
      testCommand: 'npm test -- changed.test.ts',
    })).toBeUndefined();
  });

  it('resumes a gate only from an explicit matching infrastructure marker', () => {
    const cached = evidence({
      gate_resume: {
        status: 'pending',
        step_id: 'step-1',
        workspace_fingerprint: FINGERPRINT,
        captured_at: '2026-09-22T12:01:00.000Z',
      },
    });
    expect(shouldResumeGateFromEvidence({
      evidence: cached,
      stepId: 'step-1',
      workspaceFingerprint: FINGERPRINT,
      testCommand: 'npm test',
    })).toBe(true);
    expect(shouldResumeGateFromEvidence({
      evidence: cached,
      stepId: 'step-2',
      workspaceFingerprint: FINGERPRINT,
      testCommand: 'npm test',
    })).toBe(false);
  });
});
