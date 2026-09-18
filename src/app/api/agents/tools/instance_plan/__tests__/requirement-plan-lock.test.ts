const queryResult = {
  data: [] as Array<Record<string, any>>,
  error: null as { message: string } | null,
};

const query: Record<string, jest.Mock> = {};
query.select = jest.fn(() => query);
query.eq = jest.fn(() => query);
query.in = jest.fn(() => query);
query.then = jest.fn((resolve) => Promise.resolve(queryResult).then(resolve));

const from = jest.fn(() => query);

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));

import {
  activeRequirementPlanError,
  assertRequirementPlanUpdateAllowed,
  getBlockingActivePlans,
  isRunnerOwnedRequirementStepTerminal,
  shouldProtectRequirementPlanCreation,
} from '../requirement-plan-lock';

describe('requirement plan creation lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryResult.data = [];
    queryResult.error = null;
  });

  it('only protects non-template plans with explicit requirement context', () => {
    expect(shouldProtectRequirementPlanCreation({
      requirementId: 'req-1',
      isTemplate: false,
    })).toBe(true);
    expect(shouldProtectRequirementPlanCreation({
      requirementId: undefined,
      isTemplate: false,
    })).toBe(false);
    expect(shouldProtectRequirementPlanCreation({
      requirementId: 'req-1',
      isTemplate: true,
    })).toBe(false);
  });

  it('returns active executable plans and ignores workflow templates', async () => {
    queryResult.data = [
      {
        id: 'plan-1',
        title: 'Current work',
        status: 'in_progress',
        metadata: {},
        created_at: '2026-09-16T07:00:00.000Z',
        steps: [{ status: 'pending' }],
      },
      {
        id: 'template-1',
        title: 'Reusable workflow',
        status: 'pending',
        metadata: { workflow_template: true },
        created_at: '2026-09-16T06:00:00.000Z',
        steps: [{ status: 'pending' }],
      },
    ];

    await expect(getBlockingActivePlans({
      instanceId: 'instance-1',
    })).resolves.toEqual([
      {
        id: 'plan-1',
        title: 'Current work',
        status: 'in_progress',
        createdAt: '2026-09-16T07:00:00.000Z',
      },
    ]);
    expect(query.eq).toHaveBeenCalledWith('instance_id', 'instance-1');
  });

  it('ignores stale active rows without runnable steps', async () => {
    queryResult.data = [
      {
        id: 'stale-plan',
        title: 'Stale',
        status: 'pending',
        metadata: {},
        created_at: '2026-09-16T06:00:00.000Z',
        steps: [{ status: 'completed' }, { status: 'failed', retry_count: 2 }],
      },
    ];

    await expect(getBlockingActivePlans({
      instanceId: 'instance-1',
    })).resolves.toEqual([]);
  });

  it('treats failed steps as runnable while retries remain', async () => {
    queryResult.data = [{
      id: 'retry-plan',
      status: 'in_progress',
      metadata: {},
      created_at: '2026-09-16T06:00:00.000Z',
      steps: [{ status: 'failed', retry_count: 1 }],
    }];

    await expect(getBlockingActivePlans({
      instanceId: 'instance-1',
    })).resolves.toEqual([
      expect.objectContaining({ id: 'retry-plan' }),
    ]);
  });

  it('orders concurrent runnable plans by creation time and id', async () => {
    queryResult.data = [
      {
        id: 'plan-newer',
        status: 'pending',
        metadata: {},
        created_at: '2026-09-16T07:01:00.000Z',
        steps: [{ status: 'pending' }],
      },
      {
        id: 'plan-older',
        status: 'in_progress',
        metadata: {},
        created_at: '2026-09-16T07:00:00.000Z',
        steps: [{ status: 'in_progress' }],
      },
    ];

    const plans = await getBlockingActivePlans({ instanceId: 'instance-1' });

    expect(plans.map((plan) => plan.id)).toEqual(['plan-older', 'plan-newer']);
  });

  it('produces an actionable conflict error', () => {
    expect(
      activeRequirementPlanError('req-1', {
        id: 'plan-1',
        title: 'Current work',
        status: 'pending',
      }).message,
    ).toContain('Continue or update that plan');
  });

  it('prevents requirement agents from terminating plans through update', () => {
    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      status: 'cancelled',
    })).toThrow('plan and step execution results are runner-owned');
  });

  it('allows requirement step cancellation for plan adaptation', () => {
    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      steps: [{ status: 'cancelled' }],
    })).not.toThrow();
  });

  it('prevents requirement agents from bypassing step gates through update', () => {
    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      steps: [{ status: 'completed' }],
    })).toThrow('step execution results are runner-owned');
    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      steps: [{ status: 'failed' }],
    })).toThrow('step execution results are runner-owned');
  });

  it('preserves generic plan updates and non-terminal requirement updates', () => {
    expect(() => assertRequirementPlanUpdateAllowed({
      status: 'cancelled',
      steps: [{ status: 'completed' }],
    })).not.toThrow();
    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      status: 'in_progress',
      steps: [{ status: 'in_progress' }],
    })).not.toThrow();
  });

  it('reserves requirement step terminal transitions for the runner', () => {
    expect(isRunnerOwnedRequirementStepTerminal({
      requirementId: 'req-1',
      stepStatus: 'completed',
    })).toBe(true);
    expect(isRunnerOwnedRequirementStepTerminal({
      requirementId: 'req-1',
      stepStatus: 'failed',
    })).toBe(true);
    expect(isRunnerOwnedRequirementStepTerminal({
      requirementId: 'req-1',
      stepStatus: 'in_progress',
    })).toBe(false);
    expect(isRunnerOwnedRequirementStepTerminal({
      stepStatus: 'completed',
    })).toBe(false);
  });
});
