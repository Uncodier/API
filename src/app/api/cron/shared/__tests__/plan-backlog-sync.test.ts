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

import { syncBacklogAfterPlanCompleted } from '../plan-backlog-sync';

const plan = {
  id: 'plan-1',
  steps: [{
    id: 'step-1',
    status: 'completed',
    metadata: { backlog_item_id: 'item-1' },
  }],
};

describe('syncBacklogAfterPlanCompleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItemStatus.mockResolvedValue({ id: 'item-1', status: 'done' });
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
});
