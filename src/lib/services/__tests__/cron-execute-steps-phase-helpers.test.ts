import {
  getPlanExecutionGateStep,
  MAX_INFRA_RETRIES,
  isStepInfraRetryDue,
  recordStepInfraTransientStep,
  selectPlanStepsForExecution,
  updatePlanStepStatusStep,
} from '../../../app/api/cron/shared/cron-execute-steps-phase-helpers';
import { supabaseAdmin } from '../../database/supabase-client';
import {
  recordPlanStepInfrastructureFailure,
  updatePlanStepStatusAtomically,
} from '../instance-plan-infrastructure-state';

jest.mock('@vercel/sandbox', () => ({}));
jest.mock('workflow', () => ({}));
jest.mock('../instance-plan-infrastructure-state', () => ({
  InfrastructureStateDatabaseError: class InfrastructureStateDatabaseError
    extends Error {
    code?: string;

    constructor(operation: string, error: { message: string; code?: string }) {
      super(`${operation}: ${error.message}`);
      this.name = 'InfrastructureStateDatabaseError';
      this.code = error.code;
    }
  },
  blockRequirementForCronInfrastructureCycles: jest.fn(),
  blockRequirementForInfrastructureCircuit: jest.fn(),
  recordPlanStepInfrastructureFailure: jest.fn(),
  clearPlanStepInfrastructureState: jest.fn(),
  updatePlanStepStatusAtomically: jest.fn(),
}));
jest.mock('../../database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
    update: jest.fn().mockReturnThis(),
  },
}));

const mockedSupabase = supabaseAdmin as unknown as {
  single: jest.Mock;
  maybeSingle: jest.Mock;
  update: jest.Mock;
};
const mockedRecordFailure =
  recordPlanStepInfrastructureFailure as jest.Mock;
const mockedUpdateStatus =
  updatePlanStepStatusAtomically as jest.Mock;

describe('atomic infrastructure step mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes a durable event identity and generation to the RPC wrapper', async () => {
    mockedRecordFailure.mockResolvedValue({
      state: 'applied',
      infra_count: 2,
      circuit_open: false,
      retry_at: '2026-09-17T19:10:00.000Z',
      generation: 4,
    });

    await expect(recordStepInfraTransientStep(
      'plan_1',
      'step_1',
      'cycle-1:step-1:turn:1',
      'deployment pending',
      {
        kind: 'deployment',
        provenance: 'deployment_infrastructure',
        correlation: {
          requirement_id: 'req-1',
          plan_id: 'plan_1',
          step_id: 'step_1',
          commit_sha: 'abc123',
          branch: 'feature/req-1',
        },
      },
      { expectedGeneration: 3 },
    )).resolves.toEqual({
      exhausted: false,
      circuitOpen: false,
      infraCount: 2,
      retryAt: '2026-09-17T19:10:00.000Z',
      generation: 4,
      state: 'applied',
    });

    expect(mockedRecordFailure).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'cycle-1:step-1:turn:1',
      expectedGeneration: 3,
      maxRetries: MAX_INFRA_RETRIES,
    }));
  });

  it('keeps duplicate failures capped and idempotent', async () => {
    mockedRecordFailure.mockResolvedValue({
      state: 'duplicate',
      infra_count: MAX_INFRA_RETRIES,
      circuit_open: true,
      generation: 8,
    });

    await expect(recordStepInfraTransientStep(
      'plan_1',
      'step_1',
      'same-failure',
      'another outage',
    )).resolves.toEqual({
      exhausted: true,
      circuitOpen: true,
      infraCount: MAX_INFRA_RETRIES,
      retryAt: undefined,
      generation: 8,
      state: 'duplicate',
    });
  });

  it('surfaces database failures instead of rewriting the plan locally', async () => {
    const databaseFailure = Object.assign(new Error('database unavailable'), {
      code: '08006',
    });
    mockedRecordFailure.mockRejectedValue(databaseFailure);

    await expect(recordStepInfraTransientStep(
      'plan_1',
      'step_1',
      'failure-id',
      'Sandbox unavailable',
    )).rejects.toBe(databaseFailure);
    expect(mockedSupabase.update).not.toHaveBeenCalled();
  });
});

describe('plan execution gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prevents execution until the infrastructure retry deadline', () => {
    expect(isStepInfraRetryDue(
      { infra_retry_after: '2026-09-17T19:10:00.000Z' },
      Date.parse('2026-09-17T19:09:59.000Z'),
    )).toBe(false);
    expect(isStepInfraRetryDue(
      { infra_retry_after: '2026-09-17T19:10:00.000Z' },
      Date.parse('2026-09-17T19:10:00.000Z'),
    )).toBe(true);
  });

  it('selects and preflights retryable failed work before pending work', async () => {
    const steps = [
      { id: 'pending', order: 1, status: 'pending' },
      {
        id: 'retry',
        order: 9,
        status: 'failed',
        retry_count: 1,
        infra_retry_after: '2999-01-01T00:00:00.000Z',
      },
    ];
    expect(selectPlanStepsForExecution(steps).map((step) => step.id))
      .toEqual(['retry', 'pending']);
    mockedSupabase.maybeSingle.mockResolvedValue({
      data: { status: 'in_progress', steps },
    });
    await expect(getPlanExecutionGateStep('plan_1', 'retry')).resolves.toEqual({
      runnable: false,
      reason: 'infrastructure_wait',
      infrastructureKind: undefined,
      infrastructureProvenance: undefined,
    });
  });

  it('stops automatic execution when the infrastructure circuit is open', async () => {
    mockedSupabase.maybeSingle.mockResolvedValue({
      data: {
        status: 'in_progress',
        steps: [{
          id: 'step_1',
          order: 1,
          status: 'in_progress',
          infra_retry_count: MAX_INFRA_RETRIES,
          infrastructure_circuit_open: true,
          infrastructure_kind: 'deployment',
          infrastructure_failure_provenance: 'deployment_infrastructure',
        }],
      },
    });
    await expect(getPlanExecutionGateStep('plan_1', 'step_1')).resolves.toEqual({
      runnable: false,
      reason: 'infrastructure_circuit_open',
      infrastructureKind: 'deployment',
      infrastructureProvenance: 'deployment_infrastructure',
      infrastructureGeneration: 0,
    });
  });

  it('distinguishes a database failure from a missing plan', async () => {
    mockedSupabase.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection lost', code: '08006' },
    });
    await expect(getPlanExecutionGateStep('plan_1')).rejects.toMatchObject({
      name: 'InfrastructureStateDatabaseError',
      code: '08006',
    });
  });
});

describe('product step status persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not report stale status persistence as progress', async () => {
    mockedUpdateStatus.mockResolvedValue({
      state: 'stale',
      persisted: false,
      generation: 3,
    });
    await expect(updatePlanStepStatusStep(
      'plan_1',
      'step_1',
      'completed',
      undefined,
      2,
    )).resolves.toEqual({
      state: 'stale',
      persisted: false,
      generation: 3,
    });
    expect(mockedUpdateStatus).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 2,
    }));
  });

  it('reports completion only after the atomic status write succeeds', async () => {
    mockedUpdateStatus.mockResolvedValue({
      state: 'applied',
      persisted: true,
      generation: 2,
    });
    await expect(updatePlanStepStatusStep(
      'plan_1',
      'step_1',
      'completed',
      undefined,
      2,
    )).resolves.toEqual({
      state: 'applied',
      persisted: true,
      generation: 2,
    });
  });
});
