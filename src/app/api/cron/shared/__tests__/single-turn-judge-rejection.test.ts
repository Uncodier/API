import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const patchPlanStepAtomically = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;

jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  patchPlanStepAtomically,
}));

import { persistJudgeRejection } from '../single-turn-judge-rejection';

const postGate = {
  ran: true,
  judge_verdict: 'rejected' as const,
  judge_reason: 'Navigation proof is missing.',
  judge_failure_kind: 'evidence_gap' as const,
  matched_acceptance: ['GET / returns 200'],
  unmatched_acceptance: ['Footer links resolve'],
  repair_feedback: 'Inspect and repair the footer link evidence.',
  repair_planned: {
    schema_version: 1 as const,
    diagnostic_id: 'diagnostic-1',
    repair_run_id: 'repair-1',
    status: 'planned' as const,
    failure_kind: 'evidence_gap' as const,
    source_evidence_run_id: 'evidence-1',
    contract_revision: 'contract-1',
    created_at: '2026-09-25T00:00:00.000Z',
    max_attempts: 3,
    actions: [{
      action_id: 'criterion-1:missing_semantic_receipt:1',
      kind: 'collect_evidence' as const,
      instruction: 'Capture a typed DOM receipt.',
      verification: 'Re-run the affected browser assertion.',
    }],
  },
};

describe('persistJudgeRejection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists actionable feedback and keeps a retryable step active', async () => {
    patchPlanStepAtomically.mockResolvedValue({
      persisted: true,
      state: 'applied',
      generation: 5,
    });

    const result = await persistJudgeRejection({
      planId: 'plan-1',
      stepId: 'step-1',
      postGate,
      effectiveSandboxId: 'sandbox-1',
      infrastructureGeneration: 4,
      executionEventId: 'cycle-1:step-1:turn-1',
      persistedStepMetadata: { existing: true },
    });

    expect(result).toMatchObject({
      ok: true,
      isDone: false,
      gateFailureKind: 'evidence_gap',
      gateErrorExcerpt: postGate.repair_feedback,
      infrastructureGeneration: 5,
    });
    expect(result.remediationScheduled).toBeUndefined();
    expect(patchPlanStepAtomically).toHaveBeenCalledWith({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 4,
      eventId: 'cycle-1:step-1:turn-1:judge-feedback',
      patch: {
        status: 'in_progress',
        error_message: postGate.repair_feedback,
        metadata: {
          existing: true,
          repair_run: postGate.repair_planned,
        },
      },
    });
  });

  it('stops retrying after the verification budget is exhausted', async () => {
    patchPlanStepAtomically.mockResolvedValue({
      persisted: true,
      state: 'applied',
      generation: 5,
    });

    await expect(persistJudgeRejection({
      planId: 'plan-1',
      stepId: 'step-1',
      postGate: {
        ...postGate,
        repair_planned: {
          ...postGate.repair_planned,
          status: 'exhausted',
        },
        healing_applied: 'mark_needs_review',
        verification_exhausted: true,
        terminal_step_status: 'cancelled',
      },
      effectiveSandboxId: 'sandbox-1',
      infrastructureGeneration: 4,
      executionEventId: 'cycle-1:step-1:turn-1',
    })).resolves.toMatchObject({
      ok: true,
      isDone: true,
      gatePassed: false,
      persistedTerminalStatus: 'cancelled',
      gateFailureKind: 'evidence_gap',
      infrastructureGeneration: 5,
      judgeAdjudicated: true,
    });
    expect(patchPlanStepAtomically).toHaveBeenCalledWith({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 4,
      eventId: 'cycle-1:step-1:turn-1:judge-exhausted',
      patch: {
        status: 'cancelled',
        error_message: postGate.repair_feedback,
        completed_at: expect.any(String),
        metadata: {
          repair_run: {
            ...postGate.repair_planned,
            status: 'exhausted',
          },
        },
      },
    });
  });

  it('halts when exhaustion does not confirm linked-step cancellation', async () => {
    await expect(persistJudgeRejection({
      planId: 'plan-1',
      stepId: 'step-1',
      postGate: {
        ...postGate,
        verification_exhausted: true,
      },
      effectiveSandboxId: 'sandbox-1',
      infrastructureGeneration: 4,
      executionEventId: 'cycle-1:step-1:turn-1',
    })).resolves.toMatchObject({
      ok: false,
      isDone: false,
      concurrencyHalt: true,
      infrastructureGeneration: 4,
      error: expect.stringContaining('did not confirm'),
    });
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
  });

  it('halts safely when feedback loses a concurrency race', async () => {
    patchPlanStepAtomically.mockResolvedValue({
      persisted: false,
      state: 'stale',
      generation: 6,
    });

    await expect(persistJudgeRejection({
      planId: 'plan-1',
      stepId: 'step-1',
      postGate,
      effectiveSandboxId: 'sandbox-1',
      infrastructureGeneration: 4,
      executionEventId: 'cycle-1:step-1:turn-1',
    })).resolves.toMatchObject({
      ok: false,
      concurrencyHalt: true,
      infrastructureGeneration: 6,
    });
  });
});
