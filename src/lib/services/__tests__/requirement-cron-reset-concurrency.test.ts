const mockRequirementStatusSingle = jest.fn();
const mockRequirementSingle = jest.fn();
const mockRequirementFallbackSingle = jest.fn();
const mockRequirementSelect = jest.fn();
const mockRequirementEq = jest.fn();
const mockUserActionLimit = jest.fn();
const mockUserActionSingle = jest.fn();
const mockUserActionUpdate = jest.fn();
const mockUserActionFilter = jest.fn();
const mockResumeRequirementExecution = jest.fn();

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
      if (table === 'requirements') {
        const query = {
          select: mockRequirementSelect,
          eq: mockRequirementEq,
          contains: jest.fn(),
          limit: jest.fn(),
          single: mockRequirementFallbackSingle,
          maybeSingle: mockRequirementSingle,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.contains.mockReturnValue(query);
        query.limit.mockReturnValue(query);
        return query;
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
    mockRequirementSingle.mockResolvedValue({
      data: {
        id: 'requirement-1',
        site_id: 'site-1',
        metadata: { runner_instance_id: 'instance-1' },
        cron_lock_active: false,
        cron_lock_expires_at: null,
      },
      error: null,
    });
    mockRequirementFallbackSingle.mockResolvedValue({
      data: { id: 'requirement-1' },
      error: null,
    });
    mockResumeRequirementExecution.mockResolvedValue({
      state: 'applied',
      plans_updated: 1,
      steps_cleared: 1,
      reopened_item_ids: ['review-item'],
      external_user_action_revision: 2,
    });
    mockUserActionLimit.mockResolvedValue({
      data: [{ id: 'user-action-1' }],
      error: null,
    });
    mockUserActionSingle.mockResolvedValue({
      data: {
        details: { prompt_source: 'assistant_route' },
        instance_id: 'instance-1',
        log_type: 'user_action',
        trusted_user_action: true,
      },
      error: null,
    });
  });

  it('delegates review release to the atomic recovery RPC', async () => {
    await resetRequirementOnUserAction(
      'instance-1',
      'inserted-user-action',
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
    expect(mockRequirementSelect).toHaveBeenCalledWith(
      'id, site_id, metadata, cron_lock_active, cron_lock_expires_at',
    );
    expect(mockRequirementEq).toHaveBeenCalledWith('id', 'requirement-1');
  });

  it.each(['inserted-user-action', undefined])(
    'does not recover or tag an action for a foreign owner (action=%s)',
    async (actionId) => {
      mockRequirementSingle.mockResolvedValueOnce({
        data: {
          id: 'requirement-1',
          site_id: 'site-1',
          metadata: { runner_instance_id: 'owner-instance' },
          cron_lock_active: false,
          cron_lock_expires_at: null,
        },
        error: null,
      });

      await resetRequirementOnUserAction('instance-1', actionId);

      expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
      expect(mockUserActionUpdate).not.toHaveBeenCalled();
      expect(mockUserActionSingle).not.toHaveBeenCalled();
      expect(mockUserActionLimit).not.toHaveBeenCalled();
    },
  );

  it.each(['inserted-user-action', undefined])(
    'does not recover or tag an action during a live owner claim (action=%s)',
    async (actionId) => {
      mockRequirementSingle.mockResolvedValueOnce({
        data: {
          id: 'requirement-1',
          site_id: 'site-1',
          metadata: { runner_instance_id: 'instance-1' },
          cron_lock_active: true,
          cron_lock_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });

      await resetRequirementOnUserAction('instance-1', actionId);

      expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
      expect(mockUserActionUpdate).not.toHaveBeenCalled();
      expect(mockUserActionSingle).not.toHaveBeenCalled();
      expect(mockUserActionLimit).not.toHaveBeenCalled();
    },
  );

  it('preserves recovery for the same owner after a cron claim expires', async () => {
    mockRequirementSingle.mockResolvedValueOnce({
      data: {
        id: 'requirement-1',
        site_id: 'site-1',
        metadata: { runner_instance_id: 'instance-1' },
        cron_lock_active: true,
        cron_lock_expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      error: null,
    });

    await resetRequirementOnUserAction('instance-1', 'inserted-user-action');

    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1', 'instance-1', true, 'inserted-user-action',
    );
    expect(mockUserActionUpdate).toHaveBeenCalled();
  });

  it('preserves same-owner recovery through the metadata fallback', async () => {
    mockRequirementStatusSingle.mockResolvedValueOnce({ data: null, error: null });

    await resetRequirementOnUserAction('instance-1', 'inserted-user-action');

    expect(mockRequirementFallbackSingle).toHaveBeenCalled();
    expect(mockRequirementSingle).toHaveBeenCalled();
    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1', 'instance-1', true, 'inserted-user-action',
    );
    expect(mockUserActionUpdate).toHaveBeenCalled();
  });

  it('does not recover or tag an action when the target requirement is missing', async () => {
    mockRequirementSingle.mockResolvedValueOnce({ data: null, error: null });

    await resetRequirementOnUserAction('instance-1', 'inserted-user-action');

    expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
    expect(mockUserActionUpdate).not.toHaveBeenCalled();
    expect(mockUserActionSingle).not.toHaveBeenCalled();
  });

  it('reports when recent user feedback was applied', async () => {
    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
    })).resolves.toBe(true);

    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1',
      'instance-1',
      true,
      'user-action-1',
    );
    expect(mockUserActionFilter).toHaveBeenCalledWith(
      'details->>requirement_id',
      'eq',
      'requirement-1',
    );
  });

  it('does not report duplicate feedback as a new recovery', async () => {
    mockResumeRequirementExecution.mockResolvedValueOnce({
      state: 'duplicate',
      plans_updated: 0,
      steps_cleared: 0,
      reopened_item_ids: [],
      external_user_action_revision: 2,
    });

    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
    })).resolves.toBe(false);
  });

  it('does not trust model-writable recovery metadata for deduplication', async () => {
    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
      requirement_last_resume_action_id: 'user-action-1',
    })).resolves.toBe(true);

    expect(mockResumeRequirementExecution).toHaveBeenCalled();
  });

  it('does not recover a requirement from an action tagged to another one', async () => {
    mockUserActionSingle.mockResolvedValueOnce({
      data: {
        details: { requirement_id: 'requirement-2' },
        instance_id: 'instance-1',
        log_type: 'user_action',
        trusted_user_action: true,
      },
      error: null,
    });

    await resetRequirementOnUserAction(
      'instance-1',
      'foreign-user-action',
    );

    expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
  });

  it('rejects an untrusted user-action row before recovery', async () => {
    mockUserActionSingle.mockResolvedValueOnce({
      data: {
        details: {},
        instance_id: 'instance-1',
        log_type: 'user_action',
        trusted_user_action: false,
      },
      error: null,
    });

    await resetRequirementOnUserAction('instance-1', 'forged-action');

    expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
  });

  it('lets the RPC release review items while the requirement is active', async () => {
    await expect(checkAndResetCronAttempts('requirement-1', {
      runner_instance_id: 'instance-1',
    })).resolves.toBe(true);

    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1',
      'instance-1',
      true,
      'user-action-1',
    );
  });
});
