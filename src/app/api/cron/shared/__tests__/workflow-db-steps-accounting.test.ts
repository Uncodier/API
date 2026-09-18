import { describe, expect, it, jest } from '@jest/globals';
import {
  blockRequirementWithProvenance,
  recordRequirementCronCycleOutcome,
} from '@/lib/services/requirement-metadata-patch';
import {
  recordCronCycleOutcomeStep,
  recordRequirementBlockedStep,
} from '../workflow-db-steps';

jest.mock('@/lib/services/requirement-metadata-patch', () => ({
  blockRequirementWithProvenance: jest.fn(),
  incrementRequirementMetadataCounter: jest.fn(),
  patchRequirementMetadataKeys: jest.fn(),
  recordRequirementCronCycleOutcome: jest.fn(),
}));

const mockRecordOutcome =
  recordRequirementCronCycleOutcome as jest.MockedFunction<
    typeof recordRequirementCronCycleOutcome
  >;
const mockBlockRequirement =
  blockRequirementWithProvenance as jest.MockedFunction<
    typeof blockRequirementWithProvenance
  >;

describe('recordCronCycleOutcomeStep', () => {
  it('returns the accepted accounting result', async () => {
    mockRecordOutcome.mockResolvedValue({
      accepted: true,
      is_latest: true,
      recorded_outcome: 'progress',
      metadata: { cron_attempts: 0, no_progress_cycles: 0 },
      cron_attempts: 0,
      no_progress_cycles: 0,
      infrastructure_failure_cycles: 0,
    });

    await expect(recordCronCycleOutcomeStep({
      requirementId: 'req-1',
      cycleId: 'cycle-1',
      cycleStartedAt: '2026-09-17T20:00:00.000Z',
      outcome: 'progress',
      expectedExecutionGeneration: 3,
      runnerInstanceId: 'instance-1',
    })).resolves.toMatchObject({
      accepted: true,
      recorded_outcome: 'progress',
    });
  });

  it('does not swallow accounting persistence failures', async () => {
    const persistenceFailure = Object.assign(
      new Error('cycle ledger unavailable'),
      { code: '08006' },
    );
    mockRecordOutcome.mockRejectedValue(persistenceFailure);

    await expect(recordCronCycleOutcomeStep({
      requirementId: 'req-1',
      cycleId: 'cycle-1',
      cycleStartedAt: '2026-09-17T20:00:00.000Z',
      outcome: 'product_failure',
      expectedExecutionGeneration: 3,
    })).rejects.toBe(persistenceFailure);
  });
});

describe('recordRequirementBlockedStep', () => {
  it('uses one atomic blocker transition', async () => {
    mockBlockRequirement.mockResolvedValue({
      state: 'applied',
      blocked: true,
    });

    await expect(recordRequirementBlockedStep({
      site_id: 'site-1',
      instance_id: 'instance-1',
      requirement_id: 'requirement-1',
      message: 'Re-plan circuit opened.',
      provenance: 'product_replan_circuit',
      event_id: 'cycle-1:replan-circuit',
      expected_execution_generation: 4,
    })).resolves.toEqual({ ok: true });

    expect(mockBlockRequirement).toHaveBeenCalledWith({
      siteId: 'site-1',
      instanceId: 'instance-1',
      requirementId: 'requirement-1',
      message: 'Re-plan circuit opened.',
      provenance: 'product_replan_circuit',
      eventId: 'cycle-1:replan-circuit',
      expectedExecutionGeneration: 4,
    });
  });
});
