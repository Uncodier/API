const mockMutateBacklogAtomically = jest.fn();
const mockRequirementStatusSingle = jest.fn();
const mockUserActionLimit = jest.fn();
const mockResumeRequirementExecution = jest.fn();

jest.mock('../requirement-backlog-mutation', () => ({
  mutateBacklogAtomically: mockMutateBacklogAtomically,
}));

jest.mock(
  '../requirement-execution-recovery',
  () => ({
    resumeRequirementExecutionOnUserAction: mockResumeRequirementExecution,
  }),
);

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table === 'requirement_status') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              order: jest.fn(() => ({
                limit: jest.fn(() => ({
                  single: mockRequirementStatusSingle,
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'instance_logs') {
        const query = {
          select: jest.fn(),
          eq: jest.fn(),
          order: jest.fn(),
          limit: mockUserActionLimit,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(query);
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  },
}));

import { resetRequirementOnUserAction } from '../requirement-cron-reset';

describe('resetRequirementOnUserAction concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirementStatusSingle.mockResolvedValue({
      data: { requirement_id: 'requirement-1' },
      error: null,
    });
    mockResumeRequirementExecution.mockResolvedValue(undefined);
    mockUserActionLimit.mockResolvedValue({
      data: [{ id: 'user-action-1' }],
      error: null,
    });
  });

  it('reopens review items through the atomic backlog mutator', async () => {
    mockMutateBacklogAtomically.mockImplementation(
      async (_requirementId, mutate) => {
        const outcome = await mutate({
          requirement: {
            id: 'requirement-1',
            type: 'app',
            status: 'blocked',
            metadata: { cron_attempts: 9 },
            backlog_revision: 4,
            backlog: {},
          },
          backlog: {
            schema_version: 1,
            current_phase_id: 'review',
            completion_ratio: 0,
            cycles_spent_total: 0,
            items: [{
              id: 'review-item',
              title: 'Repair checkout',
              kind: 'page',
              phase_id: 'build',
              acceptance: ['GET /checkout renders the checkout page'],
              status: 'needs_review',
              attempts: 4,
              scope_level: 'full',
            }],
          },
          flow: { phases: [] },
        });
        expect(outcome.write).toBe(true);
        expect(outcome.backlog?.items[0]).toEqual(expect.objectContaining({
          status: 'pending',
          attempts: 0,
        }));
        return outcome.result;
      },
    );

    await resetRequirementOnUserAction('instance-1');

    expect(mockMutateBacklogAtomically).toHaveBeenCalledWith(
      'requirement-1',
      expect.any(Function),
      expect.any(Object),
    );
    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1',
      'instance-1',
      true,
      'user-action-1',
    );
  });
});
