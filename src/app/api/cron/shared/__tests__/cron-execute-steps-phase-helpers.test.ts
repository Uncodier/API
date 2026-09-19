jest.mock('@/lib/services/sandbox-recovery', () => ({
  connectOrRecreateRequirementSandbox: jest.fn(),
}));
jest.mock('../cron-orchestrator-step', () => ({
  runOrchestratorStep: jest.fn(),
}));

import { getPlanExecutionGateFromStatus } from '../cron-execute-steps-phase-helpers';

describe('getPlanExecutionGateFromStatus', () => {
  it.each(['pending', 'in_progress', 'active'])(
    'treats %s plans as runnable',
    (status) => {
      expect(getPlanExecutionGateFromStatus(status)).toEqual({
        runnable: true,
        dbStatus: status,
      });
    },
  );

  it.each(['paused', 'cancelled'])(
    'returns the explicit halt reason for %s plans',
    (status) => {
      expect(getPlanExecutionGateFromStatus(status)).toEqual({
        runnable: false,
        reason: status,
      });
    },
  );
});
