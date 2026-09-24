const completeItem = jest.fn();
const markNeedsReview = jest.fn();
const setItemStatus = jest.fn();
const listBacklog = jest.fn();
const getRequirementById = jest.fn();
const upsertBacklogItem = jest.fn();
const isBacklogComplete = jest.fn();
const hasUserRequestedMoreWork = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  completeItem,
  downgradeScope: jest.fn(),
  listBacklog,
  logAssumption: jest.fn(),
  markInProgress: jest.fn(),
  markNeedsReview,
  setItemStatus,
  upsertBacklogItem,
  isBacklogComplete,
  hasUserRequestedMoreWork,
}));
jest.mock('@/lib/services/requirement-cron-reset', () => ({
  checkAndResetCronAttempts: jest.fn(),
}));
jest.mock('@/lib/services/requirement-backlog-blocker-service', () => ({
  blockBacklogItem: jest.fn(),
  resolveBacklogItemBlocker: jest.fn(),
}));
jest.mock('@/lib/database/requirement-db', () => ({
  getRequirementById,
}));

import { executeBacklogCore } from '../route';
import { requirementBacklogTool } from '../assistantProtocol';

describe('model-facing requirement backlog terminal transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBacklog.mockReset();
    getRequirementById.mockResolvedValue(null);
    isBacklogComplete.mockReturnValue(false);
  });

  it.each([
    { action: 'complete' as const },
    { action: 'mark_needs_review' as const },
    { action: 'set_status' as const, status: 'done' as const },
    { action: 'set_status' as const, status: 'rejected' as const },
    { action: 'set_status' as const, status: 'needs_review' as const },
  ])('rejects $action $status before mutating backlog state', async (transition) => {
    await expect(executeBacklogCore({
      requirement_id: 'req-1',
      item_id: 'item-1',
      ...transition,
    })).rejects.toThrow('Backlog terminal transitions are runner-owned');

    expect(completeItem).not.toHaveBeenCalled();
    expect(markNeedsReview).not.toHaveBeenCalled();
    expect(setItemStatus).not.toHaveBeenCalled();
  });

  it('does not advertise runner-owned actions or statuses to the model', () => {
    const tool = requirementBacklogTool('site-1', 'req-1') as any;
    const properties = tool.parameters.properties;

    expect(properties.action.enum).not.toEqual(
      expect.arrayContaining(['complete', 'mark_needs_review']),
    );
    expect(properties.status.enum).not.toEqual(
      expect.arrayContaining(['done', 'rejected', 'needs_review']),
    );
    expect(properties.action.enum).toEqual(
      expect.arrayContaining(['report_blocker', 'resolve_blocker']),
    );
    expect(properties.confirm_reopen).toBeUndefined();
  });

  it.each(['needs_review', 'rejected'] as const)(
    'does not let the model reopen a %s item',
    async (status) => {
    listBacklog.mockResolvedValue({
      kind: 'app',
      backlog: {
        items: [{ id: 'item-1', status }],
      },
    });

    await expect(executeBacklogCore({
      action: 'set_status',
      requirement_id: 'req-1',
      item_id: 'item-1',
      status: 'pending',
    })).rejects.toThrow('new external user action');

    expect(setItemStatus).not.toHaveBeenCalled();
    },
  );

  it('does not let upsert rewrite terminal item contracts', async () => {
    listBacklog.mockResolvedValue({
      kind: 'app',
      backlog: {
        items: [{ id: 'item-1', status: 'needs_review' }],
      },
    });

    await expect(executeBacklogCore({
      action: 'upsert',
      requirement_id: 'req-1',
      item_id: 'item-1',
      title: 'Rewrite review item',
      kind: 'page',
      phase_id: 'build',
      acceptance: ['GET /rewritten returns 200'],
    })).rejects.toThrow('cannot be rewritten by model-facing tools');
  });

  it('requires a trusted user action to extend a completed backlog', async () => {
    listBacklog.mockResolvedValue({
      kind: 'app',
      backlog: {
        items: [{ id: 'done-item', status: 'done' }],
      },
    });
    isBacklogComplete.mockReturnValue(true);
    hasUserRequestedMoreWork.mockResolvedValue(false);

    await expect(executeBacklogCore({
      action: 'upsert',
      requirement_id: 'req-1',
      title: 'Untrusted extension',
      kind: 'page',
      phase_id: 'build',
      acceptance: ['GET /extension returns 200'],
    })).rejects.toThrow('newer trusted external user action');

    expect(upsertBacklogItem).not.toHaveBeenCalled();
  });
});
