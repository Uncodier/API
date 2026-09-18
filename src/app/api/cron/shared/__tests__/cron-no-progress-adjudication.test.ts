const patchPlanStepAtomically = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));
jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  patchPlanStepAtomically,
}));
jest.mock('@/lib/services/cron-audit-log', () => ({
  logCronInfrastructureEvent: jest.fn(),
  CronInfraEvent: {},
}));
jest.mock('@/lib/services/sandbox-recovery', () => ({
  connectOrRecreateRequirementSandbox: jest.fn(),
}));
jest.mock('../cron-orchestrator-step', () => ({
  runOrchestratorStep: jest.fn(),
}));
jest.mock('@/lib/helpers/plan-status', () => ({
  PLAN_STEP_MAX_RETRIES: 2,
}));

import {
  requestNoProgressStepAdjudicationStep,
  shouldDeferNoProgressBlock,
} from '../cron-execute-steps-phase-helpers';

describe('requestNoProgressStepAdjudicationStep', () => {
  it('persists a generation-guarded adjudication request', async () => {
    patchPlanStepAtomically.mockResolvedValue({
      state: 'applied',
      persisted: true,
      generation: 12,
    });

    await expect(requestNoProgressStepAdjudicationStep({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 11,
      expectedExecutionGeneration: 7,
      cycleId: 'cycle-2',
      persistedMetadata: { backlog_item_id: 'item-1' },
    })).resolves.toEqual({
      state: 'applied',
      persisted: true,
      generation: 12,
    });

    expect(patchPlanStepAtomically).toHaveBeenCalledWith({
      planId: 'plan-1',
      stepId: 'step-1',
      expectedGeneration: 11,
      eventId: 'cycle-2:step-1:no-progress-adjudication',
      patch: {
        metadata: expect.objectContaining({
          backlog_item_id: 'item-1',
          no_progress_adjudication: expect.objectContaining({
            state: 'requested',
            cycle_id: 'cycle-2',
            execution_generation: 7,
          }),
        }),
      },
    });
  });

  it('does not activate a blocker after a stale adjudication CAS', () => {
    expect(shouldDeferNoProgressBlock({
      persisted: false,
      state: 'stale',
    })).toBe(true);
    expect(shouldDeferNoProgressBlock({
      persisted: false,
      state: 'missing',
    })).toBe(false);
  });
});
