import { syncBacklogAfterPlanCompleted } from '@/app/api/cron/shared/plan-backlog-sync';
import * as backlogService from '@/lib/services/requirement-backlog';
import * as postGateService from '@/app/api/cron/shared/step-archetype-postgate';

jest.mock('@/lib/services/requirement-backlog', () => ({
  getBacklogItem: jest.fn(),
  setItemStatus: jest.fn(),
}));

jest.mock('@/app/api/cron/shared/step-archetype-postgate', () => ({
  runArchetypePostGate: jest.fn(),
}));

jest.mock('@/lib/services/cron-audit-log', () => ({
  logCronInfrastructureEvent: jest.fn(),
  CronInfraEvent: { PLAN_RECONCILE: 'PLAN_RECONCILE' },
}));

describe('syncBacklogAfterPlanCompleted', () => {
  const requirementId = 'req-123';
  const planId = 'plan-456';
  const auditMock = { runId: 'audit-1' } as any;
  const mockSandbox = { id: 'sbx-789' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing if plan has no steps', async () => {
    await syncBacklogAfterPlanCompleted({
      requirementId,
      plan: { id: planId, steps: [] },
      audit: auditMock,
    });
    expect(backlogService.getBacklogItem).not.toHaveBeenCalled();
    expect(postGateService.runArchetypePostGate).not.toHaveBeenCalled();
  });

  it('does nothing if no steps have backlog_item_id', async () => {
    await syncBacklogAfterPlanCompleted({
      requirementId,
      plan: {
        id: planId,
        steps: [{ id: 's1', status: 'completed' }]
      },
      audit: auditMock,
    });
    expect(backlogService.getBacklogItem).not.toHaveBeenCalled();
  });

  it('skips item if it is already terminal (done)', async () => {
    const itemId = 'item-1';
    (backlogService.getBacklogItem as jest.Mock).mockResolvedValue({
      item: { id: itemId, status: 'done' }
    });

    await syncBacklogAfterPlanCompleted({
      requirementId,
      plan: {
        id: planId,
        steps: [{ id: 's1', status: 'completed', backlog_item_id: itemId }]
      },
      audit: auditMock,
    });

    expect(backlogService.getBacklogItem).toHaveBeenCalledWith(requirementId, itemId);
    expect(postGateService.runArchetypePostGate).not.toHaveBeenCalled();
  });

  it('invokes post-gate for an open item when sandbox is available', async () => {
    const itemId = 'item-2';
    (backlogService.getBacklogItem as jest.Mock).mockResolvedValue({
      item: { id: itemId, status: 'in_progress' }
    });
    (postGateService.runArchetypePostGate as jest.Mock).mockResolvedValue({
      judge_verdict: 'approved',
      healing_applied: false
    });

    await syncBacklogAfterPlanCompleted({
      requirementId,
      plan: {
        id: planId,
        steps: [{ id: 's1', status: 'completed', backlog_item_id: itemId }]
      },
      sandbox: mockSandbox,
      audit: auditMock,
    });

    expect(postGateService.runArchetypePostGate).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: mockSandbox,
      requirementId,
      backlogItemId: itemId,
      stepId: 's1'
    }));
  });

  it('bumps item to judge_review if no sandbox is available', async () => {
    const itemId = 'item-3';
    (backlogService.getBacklogItem as jest.Mock).mockResolvedValue({
      item: { id: itemId, status: 'in_progress' }
    });

    await syncBacklogAfterPlanCompleted({
      requirementId,
      plan: {
        id: planId,
        steps: [{ id: 's1', status: 'completed', backlog_item_id: itemId }]
      },
      // sandbox omitted intentionally
      audit: auditMock,
    });

    expect(postGateService.runArchetypePostGate).not.toHaveBeenCalled();
    expect(backlogService.setItemStatus).toHaveBeenCalledWith(expect.objectContaining({
      requirementId,
      itemId,
      status: 'judge_review'
    }));
  });
});
