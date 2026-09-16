const single = jest.fn();
const builder: Record<string, jest.Mock> = {};
builder.select = jest.fn(() => builder);
builder.eq = jest.fn(() => builder);
builder.insert = jest.fn(() => builder);
builder.delete = jest.fn(() => builder);
builder.single = single;
const from = jest.fn(() => builder);

const completeInProgressPlans = jest.fn();
const resolveBacklogContextForInstance = jest.fn();
const hasOutstandingWork = jest.fn();
const loadRequirement = jest.fn();
const toBacklog = jest.fn();
const getBlockingActivePlans = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));
jest.mock('@/lib/helpers/plan-lifecycle', () => ({
  completeInProgressPlans,
}));
jest.mock('@/lib/services/requirement-backlog', () => ({
  resolveBacklogContextForInstance,
  hasOutstandingWork,
}));
jest.mock('@/lib/services/requirement-backlog-store', () => ({
  loadRequirement,
  toBacklog,
}));
jest.mock('../requirement-plan-lock', () => ({
  shouldProtectRequirementPlanCreation: jest.fn(
    ({ requirementId, isTemplate }) => Boolean(requirementId && !isTemplate),
  ),
  getBlockingActivePlans,
  activeRequirementPlanError: jest.fn(
    (requirementId, plan) =>
      new Error(`Requirement ${requirementId} already has active plan ${plan.id}`),
  ),
}));

import { createInstancePlanCore } from '../create/route';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const REQUIREMENT_ID = '44444444-4444-4444-8444-444444444444';

function mockSuccessfulInsert() {
  single
    .mockResolvedValueOnce({ data: { site_id: SITE_ID }, error: null })
    .mockResolvedValueOnce({
      data: {
        id: '55555555-5555-4555-8555-555555555555',
        instance_id: INSTANCE_ID,
        created_at: '2026-09-16T07:00:00.000Z',
      },
      error: null,
    });
}

describe('createInstancePlanCore requirement lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveBacklogContextForInstance.mockResolvedValue({
      requirementId: null,
      inProgressItemId: null,
    });
    hasOutstandingWork.mockReturnValue(false);
    loadRequirement.mockResolvedValue({ backlog: { items: [] } });
    toBacklog.mockReturnValue({ items: [] });
    getBlockingActivePlans.mockResolvedValue([]);
    completeInProgressPlans.mockResolvedValue({
      success: true,
      completedCount: 0,
      errors: [],
    });
  });

  it('does not supersede plans when creation is requirement-bound', async () => {
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Requirement plan',
      steps: [{ title: 'Implement feature', instructions: 'Implement it' }],
    });

    expect(getBlockingActivePlans).toHaveBeenCalledTimes(2);
    expect(completeInProgressPlans).not.toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { requirement_id: REQUIREMENT_ID },
      }),
    );
  });

  it('preserves generic plan supersession outside requirement context', async () => {
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      title: 'Generic plan',
      steps: [{ title: 'Run generic task', instructions: 'Run it' }],
    });

    expect(getBlockingActivePlans).not.toHaveBeenCalled();
    expect(completeInProgressPlans).toHaveBeenCalledTimes(1);
  });

  it('keeps workflow templates outside the requirement execution lock', async () => {
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Requirement template',
      is_template: true,
      steps: [{ title: 'Reusable task', instructions: 'Run it' }],
    });

    expect(getBlockingActivePlans).not.toHaveBeenCalled();
    expect(completeInProgressPlans).not.toHaveBeenCalled();
  });

  it('does not auto-bind backlog context from another requirement', async () => {
    resolveBacklogContextForInstance.mockResolvedValueOnce({
      requirementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      inProgressItemId: 'foreign-item',
    });
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Scoped plan',
      steps: [{ title: 'Scoped task', instructions: 'Run it' }],
    });

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            metadata: {},
          }),
        ],
      }),
    );
  });

  it('validates an empty plan against the explicit requirement', async () => {
    resolveBacklogContextForInstance.mockResolvedValueOnce({
      requirementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      inProgressItemId: 'foreign-item',
    });
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Empty scoped plan',
      steps: [],
    });

    expect(loadRequirement).toHaveBeenCalledWith(REQUIREMENT_ID);
  });

  it('rejects a requirement plan before insertion when another plan is active', async () => {
    single.mockResolvedValueOnce({ data: { site_id: SITE_ID }, error: null });
    getBlockingActivePlans.mockResolvedValueOnce([
      { id: 'active-plan', title: 'Current work', status: 'in_progress' },
    ]);

    await expect(createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Replacement plan',
      steps: [{ title: 'Replace current work', instructions: 'Replace it' }],
    })).rejects.toThrow('already has active plan active-plan');

    expect(builder.insert).not.toHaveBeenCalled();
  });

  it('removes a concurrent non-winning requirement plan', async () => {
    mockSuccessfulInsert();
    getBlockingActivePlans
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'active-plan',
          title: 'Earlier work',
          status: 'in_progress',
          createdAt: '2026-09-16T06:59:00.000Z',
        },
        {
          id: '55555555-5555-4555-8555-555555555555',
          title: 'Replacement plan',
          status: 'pending',
          createdAt: '2026-09-16T07:00:00.000Z',
        },
      ]);

    await expect(createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Replacement plan',
      steps: [{ title: 'Replace current work', instructions: 'Replace it' }],
    })).rejects.toThrow('already has active plan active-plan');

    expect(builder.delete).toHaveBeenCalled();
  });
});
