const mockMutateBacklogAtomically = jest.fn();
const mockRequirementStatusSingle = jest.fn();
const mockUserActionLimit = jest.fn();
const mockUserActionSingle = jest.fn();
const mockUserActionUpdate = jest.fn();
const mockUserActionFilter = jest.fn();
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
          filter: mockUserActionFilter,
          gt: jest.fn(),
          order: jest.fn(),
          limit: mockUserActionLimit,
          maybeSingle: mockUserActionSingle,
          update: mockUserActionUpdate,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.filter.mockReturnValue(query);
        query.gt.mockReturnValue(query);
        query.order.mockReturnValue(query);
        query.update.mockReturnValue(query);
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  },
}));

import {
  checkAndResetCronAttempts,
  resetRequirementOnUserAction,
} from '../requirement-cron-reset';

describe('resetRequirementOnUserAction concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirementStatusSingle.mockResolvedValue({
      data: { requirement_id: 'requirement-1' },
      error: null,
    });
    mockResumeRequirementExecution.mockResolvedValue({
      state: 'applied',
      plans_updated: 1,
      steps_cleared: 1,
    });
    mockUserActionLimit.mockResolvedValue({
      data: [{ id: 'user-action-1' }],
      error: null,
    });
    mockUserActionSingle.mockResolvedValue({
      data: { details: { prompt_source: 'assistant_route' } },
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

    await resetRequirementOnUserAction(
      'instance-1',
      'inserted-user-action',
    );

    expect(mockMutateBacklogAtomically).toHaveBeenCalledWith(
      'requirement-1',
      expect.any(Function),
      expect.any(Object),
    );
    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1',
      'instance-1',
      true,
      'inserted-user-action',
    );
    expect(mockUserActionLimit).not.toHaveBeenCalled();
    expect(mockUserActionUpdate).toHaveBeenCalledWith({
      details: {
        prompt_source: 'assistant_route',
        requirement_id: 'requirement-1',
      },
    });
  });

  it('reports when recent user feedback was applied', async () => {
    mockMutateBacklogAtomically.mockResolvedValue([]);

    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
    })).resolves.toBe(true);

    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1',
      'instance-1',
      false,
      'user-action-1',
    );
    expect(mockUserActionFilter).toHaveBeenCalledWith(
      'details->>requirement_id',
      'eq',
      'requirement-1',
    );
  });

  it('does not report duplicate feedback as a new recovery', async () => {
    mockMutateBacklogAtomically.mockResolvedValue([]);
    mockResumeRequirementExecution.mockResolvedValueOnce({
      state: 'duplicate',
      plans_updated: 0,
      steps_cleared: 0,
    });

    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
    })).resolves.toBe(false);
  });

  it('does not reopen backlog items for an already consumed action', async () => {
    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
      requirement_last_resume_action_id: 'user-action-1',
    })).resolves.toBe(false);

    expect(mockMutateBacklogAtomically).not.toHaveBeenCalled();
    expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
  });

  it('does not recover a requirement from an action tagged to another one', async () => {
    mockUserActionSingle.mockResolvedValueOnce({
      data: { details: { requirement_id: 'requirement-2' } },
      error: null,
    });

    await resetRequirementOnUserAction(
      'instance-1',
      'foreign-user-action',
    );

    expect(mockMutateBacklogAtomically).not.toHaveBeenCalled();
    expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
  });
});
