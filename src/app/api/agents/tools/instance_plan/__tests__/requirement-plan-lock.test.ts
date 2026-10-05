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
      {
        id: 'workflow-run-1',
        title: 'Workflow run',
        status: 'in_progress',
        metadata: { workflow_run: true },
        created_at: '2026-09-16T06:30:00.000Z',
        steps: [{ status: 'in_progress' }],
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

  it('only blocks plans owned by the requested requirement', async () => {
    queryResult.data = [
      {
        id: 'req-1-plan',
        status: 'pending',
        metadata: { requirement_id: 'req-1' },
        created_at: '2026-09-16T06:00:00.000Z',
        steps: [{ status: 'pending' }],
      },
      {
        id: 'req-2-plan',
        status: 'in_progress',
        metadata: { requirement_id: 'req-2' },
        created_at: '2026-09-16T05:00:00.000Z',
        steps: [{ status: 'in_progress' }],
      },
    ];

    await expect(getBlockingActivePlans({
      instanceId: 'instance-1',
      requirementId: 'req-1',
    })).resolves.toEqual([
      expect.objectContaining({ id: 'req-1-plan' }),
    ]);
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

  it('requires replacement work when cancelling the last runnable step', () => {
    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      existingSteps: [{ id: 'step-1', status: 'in_progress' }],
      steps: [{ id: 'step-1', status: 'cancelled' }],
    })).toThrow('cannot cancel all executable steps');

    expect(() => assertRequirementPlanUpdateAllowed({
      requirementId: 'req-1',
      existingSteps: [{ id: 'step-1', status: 'in_progress' }],
      steps: [
        { id: 'step-1', status: 'cancelled' },
        { id: 'step-2' },
      ],
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

describe('requirement step host execution state', () => {
  const hostMetadata = {
    repair_run: { repair_run_id: 'repair-1', attempt_count: 3, status: 'exhausted', receipts: ['event-1'] },
    no_progress_adjudication: { state: 'consumed', execution_generation: 7 },
    cron_cycle_id: 'cycle-1',
    cron_execution_generation: 7,
  };
  // Database rows and model arguments arrive as JSON in the same runtime realm.
  const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const existing = () => ({ id: 'step-1', order: 1, status: 'in_progress', retry_count: 3,
    metadata: { ...jsonCopy(hostMetadata), backlog_item_id: 'item-1', custom: { keep: true } } });
  const check = (steps: Parameters<typeof assertRequirementPlanUpdateAllowed>[0]['steps'],
    existingSteps: Parameters<typeof assertRequirementPlanUpdateAllowed>[0]['existingSteps'] = [existing()]) =>
    assertRequirementPlanUpdateAllowed({ requirementId: 'req-1', steps, existingSteps });

  it.each(Object.keys(hostMetadata))('rejects forged, reset and partial metadata.%s, even cast values', key => {
    for (const value of [null, undefined, 0, {}, 'forged', { attempt_count: 3 }]) {
      expect(() => check([{ id: 'step-1', metadata: { [key]: value } }])).toThrow(`metadata.${key} is runner-owned`);
    }
  });

  it.each(Object.entries(hostMetadata))('rejects newly introduced metadata.%s on existing or appended steps', (key, value) => {
    const current = existing();
    delete (current.metadata as Record<string, unknown>)[key];
    expect(() => check([{ id: 'step-1', metadata: { [key]: value } }], [current])).toThrow('runner-owned');
    expect(() => check([{ id: 'new-step', metadata: { [key]: value } }])).toThrow('runner-owned');
    expect(() => assertRequirementPlanUpdateAllowed({ requirementId: 'req-1',
      steps: [{ metadata: { [key]: value } }] })).toThrow('runner-owned');
  });

  it.each([0, 2, 4, -1, undefined, null, '3'])('rejects retry_count changes: %j', retry_count => {
    expect(() => check([{ id: 'step-1', retry_count } as never])).toThrow('retry_count is runner-owned');
  });

  it('rejects explicit retry counters on new steps, including zero', () => {
    expect(() => check([{ id: 'new-step', retry_count: 0 }])).toThrow('retry_count is runner-owned');
    const { retry_count: _, ...legacyStep } = existing();
    expect(() => check([{ id: 'step-1', retry_count: 0 }], [legacyStep]))
      .toThrow('retry_count is runner-owned');
  });

  it.each([{ id: 'step-1' }, { order: 1 }])('permits exact echoes by %j without mutating either input', identity => {
    const current = existing();
    const incoming = { ...identity, retry_count: 3, metadata: { ...jsonCopy(hostMetadata), custom: { changed: true } } };
    // Object key order is irrelevant; nested values must remain identical.
    incoming.metadata.repair_run = { receipts: ['event-1'], status: 'exhausted', attempt_count: 3, repair_run_id: 'repair-1' };
    const before = structuredClone({ current, incoming });
    expect(() => check([incoming], [current])).not.toThrow();
    expect({ current, incoming }).toEqual(before);
  });

  it('does not allow an ID match to mask a different order-matched step', () => {
    const other = { ...existing(), id: 'step-2', order: 2, retry_count: 0,
      metadata: { ...existing().metadata, cron_execution_generation: 8 } };
    expect(() => check([{ id: 'step-1', order: 2, retry_count: 3 }], [existing(), other])).toThrow('runner-owned');
    expect(() => check([{ id: 'step-1', order: 2, metadata: hostMetadata }], [existing(), other])).toThrow('runner-owned');
  });

  it('allows omitted host fields, ordinary metadata and generic plans', () => {
    expect(() => check([{ id: 'step-1', metadata: { custom: 'updated' } }, { id: 'new-step' }])).not.toThrow();
    expect(() => check([{ id: 'step-1', metadata: {} }])).not.toThrow();
    expect(() => assertRequirementPlanUpdateAllowed({ steps: [{ retry_count: 8, metadata: hostMetadata }] })).not.toThrow();
  });
});
