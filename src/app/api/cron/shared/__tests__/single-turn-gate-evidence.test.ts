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
  it('starts a fresh evidence run while collecting a rejected proof gap', async () => {
    const result = await prepareSingleTurnGateEvidence({
      ...baseInput(),
      persistedErrorMessage:
        '[judge:evidence_gap] Failure kind: evidence_gap',
    });
    expect(result.evidenceRunId).not.toBe('evidence-run-1');
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

  it('links materialized repair receipts and identifies reused evidence', async () => {
    await prepareSingleTurnGateEvidence({
      ...baseInput(),
      backlogItemId: 'item-1',
      validatedFingerprint: 'workspace-1',
      backlogEvidence: {
        ...existingEvidence,
        tests: [{
          command: 'npm test',
          exit_code: 0,
          output_tail: 'PASS',
          ran_after_changes: true,
          step_id: 'step-1',
          workspace_fingerprint: 'workspace-1',
        }],
      },
      gateObservations: [{
        kind: 'page',
        disposition: 'pass',
        source: 'contract',
        detail: 'fresh HTTP observation',
      }],
      repairRun: {
        schema_version: 1,
        diagnostic_id: 'diagnostic-1',
        repair_run_id: 'repair-1',
        status: 'materialized',
        failure_kind: 'evidence_gap',
        source_evidence_run_id: 'evidence-run-1',
        contract_revision: 'contract-1',
        created_at: '2026-09-25T00:00:00.000Z',
        max_attempts: 3,
        attempt_count: 1,
        actions: [{
          action_id: 'action-1',
          kind: 'collect_evidence',
          instruction: 'Capture proof.',
          verification: 'Re-run probe.',
        }],
        action_receipts: [{
          receipt_id: 'receipt-1',
          repair_run_id: 'repair-1',
          action_id: 'action-1',
          attempt: 1,
          tool_call_id: 'call-1',
          tool_name: 'sandbox_run_command',
          status: 'succeeded',
          attempted_at: '2026-09-25T00:01:00.000Z',
        }],
      },
    });

    expect(mockWriteEvidence).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        evidence_provenance: {
          mode: 'mixed',
          reused_from_evidence_run_ids: ['evidence-run-1'],
        },
        repair_provenance: {
          diagnostic_id: 'diagnostic-1',
          repair_run_id: 'repair-1',
          source_evidence_run_id: 'evidence-run-1',
          action_ids: ['action-1'],
          receipt_ids: ['receipt-1'],
        },
      }),
    }));
  });
});
