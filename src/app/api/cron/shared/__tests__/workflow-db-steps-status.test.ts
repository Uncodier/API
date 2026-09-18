import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  checkInstanceAndPlanStatusStep,
  isRequirementExecutionCurrentStep,
} from '../workflow-db-steps';

const maybeSingle = jest.fn() as jest.MockedFunction<
  () => Promise<{ data: { status: string } | null; error: any }>
>;
const query = {
  select: jest.fn(),
  eq: jest.fn(),
  in: jest.fn(),
  order: jest.fn(),
  limit: jest.fn(),
  maybeSingle,
};

for (const method of ['select', 'eq', 'in', 'order', 'limit'] as const) {
  query[method].mockReturnValue(query);
}

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => query),
  },
}));

describe('checkInstanceAndPlanStatusStep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('propagates an instance status read failure', async () => {
    maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection lost', code: '08006' },
    });

    await expect(checkInstanceAndPlanStatusStep('instance-1')).rejects.toMatchObject({
      name: 'InfrastructureStateDatabaseError',
      code: '08006',
    });
  });

  it('propagates an active-plan read failure', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { status: 'running' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'statement timeout', code: '57014' },
      });

    await expect(checkInstanceAndPlanStatusStep('instance-1')).rejects.toMatchObject({
      name: 'InfrastructureStateDatabaseError',
      code: '57014',
    });
  });

  it('treats a missing active plan as a normal empty state', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { status: 'running' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    await expect(checkInstanceAndPlanStatusStep('instance-1')).resolves.toEqual({
      isPaused: false,
      hasActivePlan: false,
    });
  });

  it('rejects a stale workflow generation before final side effects', async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        status: 'running',
        metadata: { requirement_execution_generation: 8 },
      } as any,
      error: null,
    });

    await expect(
      isRequirementExecutionCurrentStep('requirement-1', 7),
    ).resolves.toBe(false);
  });
});
