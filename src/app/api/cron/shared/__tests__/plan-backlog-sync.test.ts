import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetBacklogItem = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockSetItemStatus = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockRunArchetypePostGate = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockAppendPlanRepairStepAtomically = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;

jest.mock('@/lib/services/requirement-backlog', () => ({
  getBacklogItem: mockGetBacklogItem,
  hasApprovedJudgeEvidence: jest.fn(
    (item: any) => item.evidence?.judge_verdict === 'approved',
  ),
  setItemStatus: mockSetItemStatus,
}));

jest.mock('../step-archetype-postgate', () => ({
  runArchetypePostGate: mockRunArchetypePostGate,
}));

jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { PLAN_RECONCILE: 'plan_reconcile' },
  logCronInfrastructureEvent: jest.fn(),
}));
jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  appendPlanRepairStepAtomically: mockAppendPlanRepairStepAtomically,
}));

import { syncBacklogAfterPlanCompleted } from '../plan-backlog-sync';

const plan = {
  id: 'plan-1',
  steps: [{
    id: 'step-1',
    title: 'Original implementation',
    order: 1,
    status: 'completed',
    infrastructure_generation: 4,
    metadata: { backlog_item_id: 'item-1' },
  }],
};

describe('syncBacklogAfterPlanCompleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItemStatus.mockResolvedValue({ id: 'item-1', status: 'done' });
    mockAppendPlanRepairStepAtomically.mockResolvedValue({
      state: 'applied',
      persisted: true,
      step_id: 'repair-1',
      generation: 0,
    });
  });

  it('closes an open item when approved evidence already exists', async () => {
    mockGetBacklogItem.mockResolvedValue({
      item: {
        id: 'item-1',
        status: 'in_progress',
        evidence: { judge_verdict: 'approved' },
      },
    });

    await syncBacklogAfterPlanCompleted({
      requirementId: 'requirement-1',
      plan,
    });

    expect(mockSetItemStatus).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      itemId: 'item-1',
      status: 'done',
    });
    expect(mockRunArchetypePostGate).not.toHaveBeenCalled();
  });

  it('closes an item after a successful post-gate evaluation', async () => {
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'item-1', status: 'in_progress', evidence: {} },
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: true,
      judge_verdict: 'approved',
    });

    await syncBacklogAfterPlanCompleted({
      requirementId: 'requirement-1',
      plan,
      sandbox: {} as any,
    });

    expect(mockSetItemStatus).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      itemId: 'item-1',
      status: 'done',
    });
  });

  it('surfaces unavailable post-gate evaluation', async () => {
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'item-1', status: 'in_progress', evidence: {} },
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: false,
      error: 'critic unavailable',
    });

    await expect(syncBacklogAfterPlanCompleted({
      requirementId: 'requirement-1',
      plan,
      sandbox: {} as any,
    })).rejects.toThrow('critic unavailable');
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('atomically schedules a runnable step for a rejected completed plan', async () => {
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'item-1', status: 'in_progress', evidence: {} },
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: true,
      judge_verdict: 'rejected',
      repair_planned: {
        repair_run_id: 'repair-stable',
        actions: [{ instruction: 'Capture the missing route receipt.' }],
      },
    });

    await syncBacklogAfterPlanCompleted({
      requirementId: 'requirement-1',
      plan,
      sandbox: {} as any,
    });

    expect(mockAppendPlanRepairStepAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: 'plan-1',
        sourceStepId: 'step-1',
        expectedSourceGeneration: 4,
        repairRunId: 'repair-stable',
        repairStep: expect.objectContaining({
          id: 'repair_repair-stable',
          order: 2,
          metadata: expect.objectContaining({
            backlog_item_id: 'item-1',
            repair_source_step_id: 'step-1',
            repair_run: expect.objectContaining({
              repair_run_id: 'repair-stable',
            }),
          }),
        }),
      }),
    );
    const scheduled = mockAppendPlanRepairStepAtomically.mock.calls[0][0];
    expect(scheduled.repairStep.metadata).not.toHaveProperty(
      'cron_cycle_id',
    );
  });

  it('fails explicitly when the producer generation is unavailable', async () => {
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'item-1', status: 'in_progress', evidence: {} },
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: true,
      judge_verdict: 'rejected',
      repair_planned: {
        repair_run_id: 'repair-stable',
        actions: [{ instruction: 'Capture evidence.' }],
      },
    });
    const planWithoutGeneration = {
      ...plan,
      steps: plan.steps.map(({ infrastructure_generation, ...step }) => step),
    };

    await expect(syncBacklogAfterPlanCompleted({
      requirementId: 'requirement-1',
      plan: planWithoutGeneration,
      sandbox: {} as any,
    })).rejects.toThrow(
      'Cannot persist repair run without infrastructure generation',
    );
    expect(mockAppendPlanRepairStepAtomically).not.toHaveBeenCalled();
  });

  it('does not reopen a completed plan for an exhausted repair run', async () => {
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'item-1', status: 'in_progress', evidence: {} },
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: true,
      judge_verdict: 'rejected',
      verification_exhausted: true,
      repair_planned: {
        repair_run_id: 'repair-exhausted',
        status: 'exhausted',
        actions: [{ instruction: 'No further retry.' }],
      },
    });

    await syncBacklogAfterPlanCompleted({
      requirementId: 'requirement-1',
      plan,
      sandbox: {} as any,
    });

    expect(mockAppendPlanRepairStepAtomically).not.toHaveBeenCalled();
  });
});
