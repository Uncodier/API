let requirementStatuses: Array<Record<string, any>> = [];
let requirementSummary: Record<string, any> | null = null;
let requirementDetails: Record<string, any> | null = null;

const statusQuery: Record<string, jest.Mock> = {};
statusQuery.select = jest.fn(() => statusQuery);
statusQuery.eq = jest.fn(() => statusQuery);
statusQuery.order = jest.fn(() => statusQuery);
statusQuery.limit = jest.fn(async () => ({ data: requirementStatuses, error: null }));

const requirementQuery: Record<string, jest.Mock> = {};
requirementQuery.select = jest.fn(() => requirementQuery);
requirementQuery.eq = jest.fn(() => requirementQuery);
requirementQuery.maybeSingle = jest.fn(async () => ({
  data: requirementSummary,
  error: null,
}));
requirementQuery.single = jest.fn(async () => ({
  data: requirementDetails,
  error: null,
}));

const from = jest.fn((table: string) =>
  table === 'requirement_status' ? statusQuery : requirementQuery,
);

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));

import { loadAssistantRequirementContext } from '../requirement-context';

describe('interactive assistant requirement context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requirementStatuses = [];
    requirementSummary = null;
    requirementDetails = null;
  });

  it('returns generic context when only a terminal requirement is present', async () => {
    requirementStatuses = [{
      requirement_id: 'req-done',
      stage: 'done',
    }];

    await expect(loadAssistantRequirementContext('instance-1')).resolves.toEqual({
      activeRequirementId: null,
      requirementStatusContext: '',
      progressContext: '',
      backlogContext: '',
    });
    expect(requirementQuery.maybeSingle).not.toHaveBeenCalled();
  });

  it('returns the authoritative open requirement and its active backlog item', async () => {
    requirementStatuses = [{
      requirement_id: 'req-open',
      stage: 'in-progress',
    }];
    requirementSummary = {
      status: 'in-progress',
      title: 'Open requirement',
    };
    requirementDetails = {
      progress: [{ summary: 'Started' }],
      backlog: {
        items: [
          { id: 'item-1', status: 'in_progress', title: 'Current item' },
        ],
      },
    };

    const result = await loadAssistantRequirementContext('instance-1');

    expect(result.activeRequirementId).toBe('req-open');
    expect(result.requirementStatusContext).toContain('Open requirement');
    expect(result.progressContext).toContain('Started');
    expect(result.backlogContext).toContain('Current item');
  });
});
