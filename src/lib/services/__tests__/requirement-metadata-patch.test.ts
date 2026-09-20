import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  blockRequirementForProductAttemptBudget as BlockProductBudget,
  blockRequirementWithProvenance as BlockWithProvenance,
  incrementRequirementMetadataCounter as IncrementCounter,
  patchRequirementMetadataKeys as PatchMetadata,
  recordRequirementCronCycleOutcome as RecordOutcome,
} from '../requirement-metadata-patch';

const mockRpc = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<{ data: any; error: any }>
>;

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: mockRpc },
}));

let patchRequirementMetadataKeys: typeof PatchMetadata;
let incrementRequirementMetadataCounter: typeof IncrementCounter;
let recordRequirementCronCycleOutcome: typeof RecordOutcome;
let blockRequirementForProductAttemptBudget: typeof BlockProductBudget;
let blockRequirementWithProvenance: typeof BlockWithProvenance;

beforeAll(async () => {
  ({
    blockRequirementForProductAttemptBudget,
    blockRequirementWithProvenance,
    incrementRequirementMetadataCounter,
    patchRequirementMetadataKeys,
    recordRequirementCronCycleOutcome,
  } = await import('../requirement-metadata-patch'));
});

describe('requirement metadata RPC helpers', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: {}, error: null });
  });

  it('patches only named metadata keys through the atomic RPC', async () => {
    await patchRequirementMetadataKeys({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      patch: { runner_instance_id: 'instance-1' },
      removeKeys: ['old_key'],
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'patch_requirement_metadata_keys',
      {
        p_requirement_id: '21c35450-1234-4abc-9def-0123456789ab',
        p_patch: { runner_instance_id: 'instance-1' },
        p_remove_keys: ['old_key'],
      },
    );
  });

  it('increments a metadata counter through the row-locking RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: 3, error: null });

    await expect(incrementRequirementMetadataCounter({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      key: 'no_progress_cycles',
    })).resolves.toBe(3);

    expect(mockRpc).toHaveBeenCalledWith(
      'increment_requirement_metadata_counter',
      {
        p_requirement_id: '21c35450-1234-4abc-9def-0123456789ab',
        p_key: 'no_progress_cycles',
        p_increment: 1,
        p_initial_value: 0,
      },
    );
  });

  it('records a cycle outcome with its idempotency key', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        accepted: true,
        is_latest: true,
        recorded_outcome: 'product_no_progress',
        metadata: { cron_attempts: 1, no_progress_cycles: 1 },
        cron_attempts: 1,
        no_progress_cycles: 1,
        infrastructure_failure_cycles: 0,
      },
      error: null,
    });
    await recordRequirementCronCycleOutcome({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      cycleId: 'cron-cycle-1',
      cycleStartedAt: '2026-09-17T20:00:00.000Z',
      outcome: 'product_no_progress',
      expectedExecutionGeneration: 5,
      runnerInstanceId: 'instance-1',
      planId: '31c35450-1234-4abc-9def-0123456789ab',
      stepId: 'step-1',
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'record_requirement_cron_cycle_outcome',
      {
        p_requirement_id: '21c35450-1234-4abc-9def-0123456789ab',
        p_cycle_id: 'cron-cycle-1',
        p_cycle_started_at: '2026-09-17T20:00:00.000Z',
        p_outcome: 'product_no_progress',
        p_expected_execution_generation: 5,
        p_runner_instance_id: 'instance-1',
        p_plan_id: '31c35450-1234-4abc-9def-0123456789ab',
        p_step_id: 'step-1',
      },
    );
  });

  it('returns the first accepted outcome when a cycle is replayed', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        accepted: false,
        is_latest: false,
        recorded_outcome: 'product_failure',
        metadata: { cron_attempts: 2, no_progress_cycles: 0 },
        cron_attempts: 2,
        no_progress_cycles: 0,
        infrastructure_failure_cycles: 0,
      },
      error: null,
    });

    await expect(recordRequirementCronCycleOutcome({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      cycleId: 'cron-cycle-1',
      cycleStartedAt: '2026-09-17T20:00:00.000Z',
      outcome: 'progress',
      expectedExecutionGeneration: 5,
    })).resolves.toMatchObject({
      accepted: false,
      recorded_outcome: 'product_failure',
      cron_attempts: 2,
    });
    expect(mockRpc).toHaveBeenLastCalledWith(
      'record_requirement_cron_cycle_outcome',
      expect.objectContaining({
        p_plan_id: null,
        p_step_id: null,
      }),
    );
  });

  it('falls back to the legacy cycle RPC during gradual deployment', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'PGRST202',
          message:
            'Could not find record_requirement_cron_cycle_outcome in schema cache',
        },
      })
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          is_latest: true,
          recorded_outcome: 'progress',
          metadata: {},
          cron_attempts: 0,
          no_progress_cycles: 0,
          infrastructure_failure_cycles: 0,
        },
        error: null,
      });

    await recordRequirementCronCycleOutcome({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      cycleId: 'cron-cycle-legacy',
      cycleStartedAt: '2026-09-19T20:00:00.000Z',
      outcome: 'progress',
      expectedExecutionGeneration: 5,
      runnerInstanceId: 'instance-1',
      planId: '31c35450-1234-4abc-9def-0123456789ab',
      stepId: 'step-1',
    });

    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      'record_requirement_cron_cycle_outcome',
      expect.not.objectContaining({
        p_plan_id: expect.anything(),
        p_step_id: expect.anything(),
      }),
    );
  });

  it('blocks a product attempt budget against the latest accounted cycle', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { state: 'applied', blocked: true },
      error: null,
    });

    await expect(blockRequirementForProductAttemptBudget({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      siteId: '31c35450-1234-4abc-9def-0123456789ab',
      instanceId: '41c35450-1234-4abc-9def-0123456789ab',
      cycleId: 'cron-cycle-4',
      maxAttempts: 4,
      message: 'Product attempt budget exhausted.',
      expectedExecutionGeneration: 6,
    })).resolves.toEqual({ state: 'applied', blocked: true });

    expect(mockRpc).toHaveBeenCalledWith(
      'block_requirement_for_product_attempt_budget',
      expect.objectContaining({
        p_cycle_id: 'cron-cycle-4',
        p_max_attempts: 4,
        p_expected_execution_generation: 6,
      }),
    );
  });

  it('persists blocker status and provenance through one RPC', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { state: 'applied', blocked: true },
      error: null,
    });

    await blockRequirementWithProvenance({
      requirementId: '21c35450-1234-4abc-9def-0123456789ab',
      siteId: '31c35450-1234-4abc-9def-0123456789ab',
      instanceId: '41c35450-1234-4abc-9def-0123456789ab',
      provenance: 'product_replan_circuit',
      message: 'Re-plan circuit opened.',
      eventId: 'cycle-1:replan-circuit',
      expectedExecutionGeneration: 7,
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'block_requirement_with_provenance',
      expect.objectContaining({
        p_provenance: 'product_replan_circuit',
        p_event_id: 'cycle-1:replan-circuit',
        p_expected_execution_generation: 7,
      }),
    );
  });
});
