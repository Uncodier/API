import { describe, expect, it } from '@jest/globals';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

import { prepareSingleTurnGateEvidence } from '../single-turn-gate-evidence';

const existingEvidence = {
  schema_version: 1 as const,
  item_id: 'item-1',
  evidence_run_id: 'evidence-run-1',
  captured_at: '2026-09-23T00:00:00.000Z',
  critic_passes: 0,
};

function baseInput() {
  return {
    sandbox: {} as any,
    cwd: '/vercel/sandbox',
    requirementId: 'requirement-1',
    backlogItemId: null,
    stepId: 'step-1',
    result: {},
    backlogEvidence: existingEvidence,
    transientGateFailure: false,
  };
}

describe('single-turn gate evidence preparation', () => {
  it('keeps the evidence run while collecting a rejected proof gap', async () => {
    await expect(prepareSingleTurnGateEvidence({
      ...baseInput(),
      persistedErrorMessage:
        '[judge:evidence_gap] Failure kind: evidence_gap',
    })).resolves.toMatchObject({
      evidenceRunId: 'evidence-run-1',
    });
  });

  it('starts a new evidence run for a normal product cycle', async () => {
    const result = await prepareSingleTurnGateEvidence(baseInput());

    expect(result.evidenceRunId).not.toBe('evidence-run-1');
  });
});
