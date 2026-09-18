const mockMutateBacklogAtomically = jest.fn();
const mockPatchRequirementMetadataKeys = jest.fn();
const mockRequirementUpdate = jest.fn();
const mockResumeRequirementExecution = jest.fn();

jest.mock('@/lib/services/requirement-backlog-mutation', () => ({
  mutateBacklogAtomically: mockMutateBacklogAtomically,
}));

jest.mock('@/lib/services/requirement-metadata-patch', () => ({
  patchRequirementMetadataKeys: mockPatchRequirementMetadataKeys,
}));

jest.mock('@/lib/services/requirement-execution-recovery', () => ({
  resumeRequirementExecutionOnUserAction: mockResumeRequirementExecution,
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table !== 'requirements') {
        throw new Error(`Unexpected table ${table}`);
      }
      return { update: mockRequirementUpdate };
    }),
  },
}));

import { prepareRequirementForCronRun } from '../route-state';

describe('prepareRequirementForCronRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-17T20:30:30.000Z'));
    mockRequirementUpdate.mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    mockPatchRequirementMetadataKeys.mockResolvedValue({
      cron_attempts: 0,
      all_done_cycles: 0,
      has_completed_backlog: false,
    });
    mockResumeRequirementExecution.mockResolvedValue(undefined);
    mockMutateBacklogAtomically.mockImplementation(
      async (_requirementId, mutate) => {
        const backlog = {
          schema_version: 1,
          current_phase_id: 'build',
          completion_ratio: 1,
          cycles_spent_total: 0,
          items: [{
            id: 'done-item',
            title: 'Initial delivery',
            kind: 'page',
            phase_id: 'build',
            acceptance: ['GET / returns 200'],
            status: 'done',
            attempts: 0,
            scope_level: 'full',
          }],
        };
        return (await mutate({ backlog })).result;
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reactivates a due cron requirement through the atomic backlog writer', async () => {
    const result = await prepareRequirementForCronRun({
      requirement: {
        id: 'requirement-1',
        status: 'blocked',
        site_id: 'site-1',
        cron: '* * * * *',
        updated_at: '2026-09-17T20:20:00.000Z',
        metadata: { cron_attempts: 8 },
        backlog: {
          items: [{
            id: 'done-item',
            status: 'done',
            tier: 'core',
            updated_at: '2026-09-17T20:20:00.000Z',
          }],
        },
      },
      currentStatus: 'blocked',
      instanceId: 'instance-1',
    });

    expect(result.status).toBe('in-progress');
    expect(result.backlog?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'subtask',
        status: 'pending',
      }),
    ]));
    expect(mockMutateBacklogAtomically).toHaveBeenCalledTimes(1);
    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'requirement-1',
      'instance-1',
      false,
      'scheduled-cron:2026-09-17T20:30:00.000Z',
      true,
    );
    expect(mockPatchRequirementMetadataKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ all_done_cycles: 0 }),
      }),
    );
  });

  it('discovers blocked requirements without running an undued blocked cycle', async () => {
    const result = await prepareRequirementForCronRun({
      requirement: {
        id: 'requirement-2',
        status: 'blocked',
        site_id: 'site-1',
        metadata: {},
        backlog: {
          items: [{
            id: 'pending-item',
            status: 'pending',
            tier: 'core',
          }],
        },
      },
      currentStatus: 'blocked',
      instanceId: 'instance-2',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      skipReason: 'blocked',
    });
    expect(mockResumeRequirementExecution).not.toHaveBeenCalled();
  });
});
