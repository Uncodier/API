const mockGetBacklogItem = jest.fn();
const mockBumpItemAttempts = jest.fn();
const mockRecordToolFailure = jest.fn();
const mockLogAssumption = jest.fn();
const mockDowngradeScope = jest.fn();
const mockMarkNeedsReview = jest.fn();
const mockClassifyFailure = jest.fn();
const mockPlanNextHealingAction = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  bumpItemAttempts: mockBumpItemAttempts,
  downgradeScope: mockDowngradeScope,
  getBacklogItem: mockGetBacklogItem,
  logAssumption: mockLogAssumption,
  markNeedsReview: mockMarkNeedsReview,
  recordToolFailure: mockRecordToolFailure,
}));

jest.mock('@/lib/services/failure-classification', () => ({
  classifyFailure: mockClassifyFailure,
}));

jest.mock('@/lib/services/requirement-self-heal', () => ({
  planNextHealingAction: mockPlanNextHealingAction,
}));

import { applyGateFailureHealing } from '../gate-failure-healing';

const baseParams = {
  requirementId: 'requirement-1',
  backlogItemId: 'item-1',
  error: 'Interaction gate failed',
  categories: ['interaction'] as const,
  flow: 'app',
  signals: [{ name: 'interaction', ok: false }],
  logPrefix: '[Test]',
};

describe('gate failure healing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not charge or relabel mandatory remediation as a failure', async () => {
    await applyGateFailureHealing({
      ...baseParams,
      categories: [...baseParams.categories],
      remediationScheduled: true,
      skipAttemptBump: true,
    });

    expect(mockGetBacklogItem).not.toHaveBeenCalled();
    expect(mockBumpItemAttempts).not.toHaveBeenCalled();
    expect(mockRecordToolFailure).not.toHaveBeenCalled();
  });

  it('charges exactly one attempt for a real product gate failure', async () => {
    const item = {
      id: 'item-1',
      title: 'Build page',
      kind: 'page',
      phase_id: 'build',
      acceptance: ['GET / returns 200'],
      status: 'in_progress',
      attempts: 0,
      scope_level: 'full',
      tier: 'core',
    };
    mockGetBacklogItem.mockResolvedValue({ item });
    mockClassifyFailure.mockReturnValue({
      failureClass: 'product',
      countsTowardAttempts: true,
    });
    mockBumpItemAttempts.mockResolvedValue({ ...item, attempts: 1 });
    mockPlanNextHealingAction.mockReturnValue({
      kind: 'rotate_strategy',
      hint: 'Repair the first failing category.',
    });

    await applyGateFailureHealing({
      ...baseParams,
      categories: [...baseParams.categories],
    });

    expect(mockBumpItemAttempts).toHaveBeenCalledTimes(1);
    expect(mockLogAssumption).toHaveBeenCalledWith(expect.objectContaining({
      assumption: expect.stringContaining('Repair the first failing category'),
    }));
  });

  it('does not charge advisory or unknown findings', async () => {
    await applyGateFailureHealing({
      ...baseParams,
      categories: [],
      signals: [
        {
          name: 'observation:page',
          ok: true,
          disposition: 'advisory',
        },
        {
          name: 'observation:visual',
          ok: true,
          disposition: 'unknown',
        },
      ],
    });

    expect(mockGetBacklogItem).not.toHaveBeenCalled();
    expect(mockBumpItemAttempts).not.toHaveBeenCalled();
  });
});
