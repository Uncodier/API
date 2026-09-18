import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  InfrastructureStateDatabaseError,
  blockRequirementForInfrastructureCircuit,
  blockRequirementForCronInfrastructureCycles,
  blockRequirementForProductNoProgress,
  clearPlanStepInfrastructureState,
  patchPlanStepAtomically,
  recordPlanStepInfrastructureFailure,
  updatePlanStepStatusAtomically,
} from '../instance-plan-infrastructure-state';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: jest.fn() },
}));

const mockRpc = supabaseAdmin.rpc as unknown as jest.MockedFunction<
  (...args: any[]) => Promise<{ data: any; error: any }>
>;

describe('instance plan infrastructure state RPC wrappers', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('records a failure with its unique event and expected generation', async () => {
    mockRpc.mockResolvedValue({
      data: {
        state: 'applied',
        infra_count: 1,
        circuit_open: false,
        generation: 4,
      },
      error: null,
    });

    await recordPlanStepInfrastructureFailure({
      planId: 'plan-1',
      stepId: 'step-1',
      eventId: 'cycle-1:step-1:turn:1',
      errorMessage: 'deployment pending',
      maxRetries: 4,
      expectedGeneration: 3,
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'record_instance_plan_step_infrastructure_failure',
      expect.objectContaining({
        p_event_id: 'cycle-1:step-1:turn:1',
        p_expected_generation: 3,
        p_max_retries: 4,
      }),
    );
  });

  it('clears state conditionally by generation', async () => {
    mockRpc.mockResolvedValue({
      data: { state: 'stale', cleared: false, generation: 7 },
      error: null,
    });
    await expect(clearPlanStepInfrastructureState({
      planId: 'plan-1',
      stepId: 'step-1',
      eventId: 'success-1',
      expectedGeneration: 6,
    })).resolves.toEqual({
      state: 'stale',
      cleared: false,
      generation: 7,
    });
  });

  it('persists product status through the targeted row-locking RPC', async () => {
    mockRpc.mockResolvedValue({
      data: { state: 'applied', persisted: true, generation: 7 },
      error: null,
    });
    await expect(updatePlanStepStatusAtomically({
      planId: 'plan-1',
      stepId: 'step-1',
      status: 'completed',
      expectedGeneration: 7,
    })).resolves.toMatchObject({ persisted: true });
    expect(mockRpc).toHaveBeenCalledWith(
      'update_instance_plan_step_status_atomic',
      expect.objectContaining({
        p_step_id: 'step-1',
        p_status: 'completed',
        p_expected_generation: 7,
      }),
    );
  });

  it('patches a step through a generation-guarded event', async () => {
    mockRpc.mockResolvedValue({
      data: { state: 'applied', persisted: true, generation: 5 },
      error: null,
    });

    await expect(patchPlanStepAtomically({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 4,
      eventId: 'cycle-1:step-1:start',
      patch: { status: 'in_progress' },
    })).resolves.toMatchObject({ persisted: true, generation: 5 });
    expect(mockRpc).toHaveBeenCalledWith(
      'patch_instance_plan_step_atomic',
      expect.objectContaining({
        p_expected_generation: 4,
        p_event_id: 'cycle-1:step-1:start',
      }),
    );
  });

  it('guards step and requirement circuit transitions with durable identities', async () => {
    mockRpc.mockResolvedValue({
      data: { state: 'applied', blocked: true, generation: 4 },
      error: null,
    });
    await blockRequirementForInfrastructureCircuit({
      requirementId: 'req-1',
      siteId: 'site-1',
      instanceId: 'instance-1',
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 4,
      provenance: 'deployment_infrastructure',
      message: 'Deployment retry budget exhausted',
      eventId: 'failure-4',
      expectedExecutionGeneration: 9,
    });
    expect(mockRpc).toHaveBeenLastCalledWith(
      'block_requirement_for_infrastructure_circuit',
      expect.objectContaining({
        p_expected_generation: 4,
        p_event_id: 'failure-4',
        p_expected_execution_generation: 9,
      }),
    );

    mockRpc.mockResolvedValueOnce({
      data: { state: 'applied', blocked: true },
      error: null,
    });
    await blockRequirementForCronInfrastructureCycles({
      requirementId: 'req-1',
      siteId: 'site-1',
      instanceId: 'instance-1',
      cycleId: 'cycle-4',
      minimumFailures: 4,
      message: 'Database infrastructure circuit exhausted',
      expectedExecutionGeneration: 9,
    });
    expect(mockRpc).toHaveBeenLastCalledWith(
      'block_requirement_for_cron_infrastructure_cycles',
      expect.objectContaining({
        p_cycle_id: 'cycle-4',
        p_minimum_failures: 4,
        p_expected_execution_generation: 9,
      }),
    );

    mockRpc.mockResolvedValueOnce({
      data: { state: 'applied', blocked: true },
      error: null,
    });
    await blockRequirementForProductNoProgress({
      requirementId: 'req-1',
      siteId: 'site-1',
      instanceId: 'instance-1',
      cycleId: 'cycle-5',
      minimumFailures: 3,
      message: 'No product progress',
      expectedExecutionGeneration: 9,
    });
    expect(mockRpc).toHaveBeenLastCalledWith(
      'block_requirement_for_product_no_progress',
      expect.objectContaining({
        p_cycle_id: 'cycle-5',
        p_expected_execution_generation: 9,
      }),
    );
  });

  it('preserves database error fields', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        message: 'serialization failure',
        code: '40001',
        details: 'retry transaction',
        hint: 'retry',
      },
    });
    const error = await recordPlanStepInfrastructureFailure({
      planId: 'plan-1',
      stepId: 'step-1',
      eventId: 'failure-1',
      maxRetries: 4,
      expectedGeneration: 0,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(InfrastructureStateDatabaseError);
    expect(error).toMatchObject({
      code: '40001',
      details: 'retry transaction',
      hint: 'retry',
    });
  });
});
