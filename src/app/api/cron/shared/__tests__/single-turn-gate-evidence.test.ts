import { describe, expect, it } from '@jest/globals';

const mockWriteEvidence = jest.fn();

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));
jest.mock('@/lib/services/requirement-ground-truth', () => ({
  writeEvidence: mockWriteEvidence,
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

  it('persists target resolution provenance with probe evidence', async () => {
    await prepareSingleTurnGateEvidence({
      ...baseInput(),
      backlogItemId: 'item-1',
      gateObservations: [{
        kind: 'page',
        disposition: 'pass',
        source: 'contract',
        target: '/campaigns',
        detail: 'HTTP 200',
        criterion_id: 'campaign-page',
        target_resolution: {
          criterion_id: 'campaign-page',
          kind: 'page',
          path: '/campaigns',
          status: 'declared',
          strategy: 'declared_contract',
          required: true,
        },
      }],
    });

    expect(mockWriteEvidence).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        target_resolutions: [
          expect.objectContaining({
            criterion_id: 'campaign-page',
            strategy: 'declared_contract',
          }),
        ],
      }),
    }));
  });
});
