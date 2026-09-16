const completeItem = jest.fn();
const markNeedsReview = jest.fn();
const setItemStatus = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  completeItem,
  downgradeScope: jest.fn(),
  listBacklog: jest.fn(),
  logAssumption: jest.fn(),
  markInProgress: jest.fn(),
  markNeedsReview,
  setItemStatus,
  upsertBacklogItem: jest.fn(),
  isRequirementReopened: jest.fn(),
  isBacklogComplete: jest.fn(),
  hasUserRequestedMoreWork: jest.fn(),
}));
jest.mock('@/lib/services/requirement-cron-reset', () => ({
  checkAndResetCronAttempts: jest.fn(),
}));
jest.mock('@/lib/database/requirement-db', () => ({
  getRequirementById: jest.fn(),
}));

import { executeBacklogCore } from '../route';
import { requirementBacklogTool } from '../assistantProtocol';

describe('model-facing requirement backlog terminal transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });
});
