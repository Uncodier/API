const mockLoadRequirement = jest.fn();
const mockWriteBacklog = jest.fn();
const mockToBacklog = jest.fn();
const mockReconcilePhase = jest.fn();
const mockCancelPlanSteps = jest.fn();

class MockBacklogWriteConflictError extends Error {}

jest.mock('../requirement-backlog-store', () => ({
  BacklogWriteConflictError: MockBacklogWriteConflictError,
  computeRatio: jest.fn().mockReturnValue(0),
  loadRequirement: mockLoadRequirement,
  reconcilePhaseForItem: mockReconcilePhase,
  toBacklog: mockToBacklog,
  writeBacklogCas: mockWriteBacklog,
}));

jest.mock('@/lib/helpers/plan-lifecycle', () => ({
  cancelPlanStepsForBacklogItem: mockCancelPlanSteps,
}));

import {
  markInProgress,
  setItemStatus,
  suspendItemForRemediation,
  upsertBacklogItem,
} from '../requirement-backlog';
import type { RequirementBacklog } from '../requirement-backlog-types';

function backlog(): RequirementBacklog {
  return {
    schema_version: 1 as const,
    current_phase_id: 'build',
    completion_ratio: 0,
    cycles_spent_total: 0,
    items: [
      {
        id: 'parent',
        title: 'Build landing page',
        kind: 'page' as const,
        phase_id: 'build',
        acceptance: ['GET / returns 200'],
        status: 'in_progress' as const,
        attempts: 2,
        scope_level: 'minimal' as const,
      },
      {
        id: 'repair',
        title: 'Remove broken navigation',
        kind: 'component' as const,
        phase_id: 'build',
        acceptance: ['Footer updates navigation'],
        status: 'pending' as const,
        attempts: 0,
        scope_level: 'full' as const,
      },
    ],
  };
}

describe('mandatory backlog remediation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadRequirement.mockResolvedValue({
      id: 'requirement',
      type: 'app',
      backlog: {},
      backlog_revision: 0,
      metadata: {},
    });
    mockToBacklog.mockImplementation(() => backlog());
    mockWriteBacklog.mockResolvedValue(undefined);
    mockCancelPlanSteps.mockResolvedValue({
      plansTouched: 1,
      plansCancelled: 1,
      stepsCancelled: 2,
      planIds: ['plan-1'],
      errors: [],
    });
  });

  it('suspends the parent behind the remediation without spending an attempt', async () => {
    const parent = await suspendItemForRemediation({
      requirementId: 'requirement',
      itemId: 'parent',
      remediationItemIds: ['repair'],
      reason: 'Resolve /privacy',
    });

    expect(parent).toEqual(expect.objectContaining({
      status: 'pending',
      attempts: 2,
      depends_on: ['repair'],
    }));
    expect(mockCancelPlanSteps).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'parent',
    }));
  });

  it('does not spend an attempt merely by starting an item', async () => {
    const pendingBacklog = backlog();
    pendingBacklog.items[0].status = 'pending';
    mockToBacklog.mockReturnValueOnce(pendingBacklog);

    const started = await markInProgress({
      requirementId: 'requirement',
      itemId: 'parent',
    });

    expect(started).toEqual(expect.objectContaining({
      status: 'in_progress',
      attempts: 2,
    }));
  });

  it('does not hide a failed terminal-step cancellation', async () => {
    mockCancelPlanSteps.mockResolvedValueOnce({
      plansTouched: 0,
      plansCancelled: 0,
      stepsCancelled: 0,
      planIds: [],
      errors: ['cancel_plan_steps: database unavailable'],
    });

    await expect(setItemStatus({
      requirementId: 'requirement',
      itemId: 'parent',
      status: 'needs_review',
      reason: 'acceptance failed',
    })).rejects.toThrow(/database unavailable/);
  });

  it('rejects an unknown dependency during upsert', async () => {
    await expect(upsertBacklogItem({
      requirementId: 'requirement',
      item: {
        id: 'new-item',
        title: 'Build account page',
        kind: 'page',
        phase_id: 'build',
        acceptance: ['GET /account returns 200'],
        depends_on: ['missing-item'],
      },
    })).rejects.toThrow(/depends on unknown item "missing-item"/);

    expect(mockWriteBacklog).not.toHaveBeenCalled();
  });

  it('rejects a self dependency during remediation suspension', async () => {
    await expect(suspendItemForRemediation({
      requirementId: 'requirement',
      itemId: 'parent',
      remediationItemIds: ['parent'],
      reason: 'Invalid remediation',
    })).rejects.toThrow(/cannot depend on itself/);

    expect(mockWriteBacklog).not.toHaveBeenCalled();
    expect(mockCancelPlanSteps).not.toHaveBeenCalled();
  });

  it('rejects a dependency cycle during remediation suspension', async () => {
    const cyclicBacklog = backlog();
    cyclicBacklog.items[1].depends_on = ['parent'];
    mockToBacklog.mockReturnValueOnce(cyclicBacklog);

    await expect(suspendItemForRemediation({
      requirementId: 'requirement',
      itemId: 'parent',
      remediationItemIds: ['repair'],
      reason: 'Invalid remediation',
    })).rejects.toThrow(/parent -> repair -> parent/);

    expect(mockWriteBacklog).not.toHaveBeenCalled();
    expect(mockCancelPlanSteps).not.toHaveBeenCalled();
  });

  it('blocks a dependency-gated start through markInProgress', async () => {
    const blockedBacklog = backlog();
    blockedBacklog.items[0].status = 'pending';
    blockedBacklog.items[0].depends_on = ['repair'];
    mockToBacklog.mockReturnValueOnce(blockedBacklog);

    await expect(markInProgress({
      requirementId: 'requirement',
      itemId: 'parent',
    })).rejects.toThrow(/dependencies are not done: repair \(pending\)/);

    expect(mockWriteBacklog).not.toHaveBeenCalled();
  });

  it('blocks a dependency-gated start through setItemStatus', async () => {
    const blockedBacklog = backlog();
    blockedBacklog.items[0].status = 'pending';
    blockedBacklog.items[0].depends_on = ['repair'];
    mockToBacklog.mockReturnValueOnce(blockedBacklog);

    await expect(setItemStatus({
      requirementId: 'requirement',
      itemId: 'parent',
      status: 'in_progress',
    })).rejects.toThrow(/dependencies are not done: repair \(pending\)/);

    expect(mockWriteBacklog).not.toHaveBeenCalled();
  });

  it('resets product and tool attempts in the same reopen mutation', async () => {
    const reviewBacklog = backlog();
    reviewBacklog.items[0].status = 'needs_review';
    reviewBacklog.items[0].attempts = 4;
    reviewBacklog.items[0].tool_failures = { runtime: 3 };
    mockToBacklog.mockReturnValueOnce(reviewBacklog);

    const reopened = await setItemStatus({
      requirementId: 'requirement',
      itemId: 'parent',
      status: 'pending',
    });

    expect(reopened).toEqual(expect.objectContaining({
      status: 'pending',
      attempts: 0,
      tool_failures: {},
    }));
    expect(mockWriteBacklog).toHaveBeenCalledWith(
      'requirement',
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: 'parent',
            status: 'pending',
            attempts: 0,
          }),
        ]),
      }),
      0,
    );
  });

  it('prevents setItemStatus from bypassing WIP across review states', async () => {
    const activeBacklog = backlog();
    activeBacklog.items[0].status = 'critic_review';
    activeBacklog.items[1].status = 'in_progress';
    mockToBacklog.mockReturnValueOnce(activeBacklog);

    await expect(setItemStatus({
      requirementId: 'requirement',
      itemId: 'repair',
      status: 'judge_review',
    })).rejects.toThrow(/WIP=1 violation/);

    expect(mockWriteBacklog).not.toHaveBeenCalled();
  });

  it('allows one item to advance through internal review states', async () => {
    const reviewBacklog = backlog();
    reviewBacklog.items[0].depends_on = ['repair'];
    reviewBacklog.items[1].status = 'done';
    mockToBacklog.mockReturnValueOnce(reviewBacklog);

    const reviewing = await setItemStatus({
      requirementId: 'requirement',
      itemId: 'parent',
      status: 'critic_review',
    });

    expect(reviewing.status).toBe('critic_review');
    expect(mockWriteBacklog).toHaveBeenCalledTimes(1);
  });
});
