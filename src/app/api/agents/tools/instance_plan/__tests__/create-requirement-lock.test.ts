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
      steps: [{
        title: 'Implement feature',
        instructions: 'Implement it',
        protected_routes: ['/dashboard/orders'],
        validation_targets: [{
          kind: 'api',
          path: '/api/orders',
          method: 'POST',
          expected_statuses: [201],
          payload: { product_id: 'product-1' },
        }],
      }],
    });

    expect(getBlockingActivePlans).toHaveBeenCalledTimes(2);
    expect(completeInProgressPlans).not.toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { requirement_id: REQUIREMENT_ID },
        steps: [
          expect.objectContaining({
            metadata: expect.objectContaining({
              protected_routes: ['/dashboard/orders'],
              validation_targets: [
                expect.objectContaining({
                  kind: 'api',
                  path: '/api/orders',
                  method: 'POST',
                }),
              ],
            }),
          }),
        ],
      }),
    );
  });

  it('rejects pre-completed steps at creation time', async () => {
    await expect(createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      title: 'Invalid completed plan',
      steps: [{
        title: 'Already complete',
        status: 'completed',
      }],
    })).rejects.toThrow();

    expect(builder.insert).not.toHaveBeenCalled();
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

  it('infers requirement protection when the direct caller omits requirement_id', async () => {
    resolveBacklogContextForInstance.mockResolvedValueOnce({
      requirementId: REQUIREMENT_ID,
      inProgressItemId: 'item-1',
    });
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      title: 'Direct route plan',
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

  it('persists normalized browser capabilities on created steps', async () => {
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      title: 'Interactive workflow',
      is_template: true,
      steps: [{
        title: 'Choose an option',
        instructions: 'Select the first option.',
        requires_browser: false,
        browser_interaction_required: true,
        browser_allowed_domains: ['example.com'],
        browser_secret_names: ['SERVICE_USER'],
      }],
    });

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            requires_sandbox: true,
            requires_browser: true,
            browser_interaction_required: true,
            browser_allowed_domains: ['example.com'],
            browser_secret_names: ['SERVICE_USER'],
          }),
        ],
      }),
    );
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

  it('rejects open-ended standalone research for a build-phase item', async () => {
    single.mockResolvedValueOnce({ data: { site_id: SITE_ID }, error: null });
    resolveBacklogContextForInstance.mockResolvedValueOnce({
      requirementId: REQUIREMENT_ID,
      inProgressItemId: 'build-item',
    });
    loadRequirement.mockResolvedValueOnce({
      backlog: {
        items: [{ id: 'build-item', phase_id: 'build', status: 'in_progress' }],
      },
    });
    toBacklog.mockReturnValueOnce({
      items: [{ id: 'build-item', phase_id: 'build', status: 'in_progress' }],
    });

    await expect(createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Bad build plan',
      steps: [{
        title: 'Investigate current implementation',
        type: 'research',
        skill: 'makinari-rol-frontend',
        instructions: 'Keep looking for possible errors.',
      }],
    })).rejects.toThrow('Standalone research step');

    expect(builder.insert).not.toHaveBeenCalled();
  });

  it('rejects role-based research disguised as a task', async () => {
    single.mockResolvedValueOnce({ data: { site_id: SITE_ID }, error: null });
    resolveBacklogContextForInstance.mockResolvedValueOnce({
      requirementId: REQUIREMENT_ID,
      inProgressItemId: 'build-item',
    });
    loadRequirement.mockResolvedValueOnce({
      backlog: {
        items: [{ id: 'build-item', phase_id: 'build', status: 'in_progress' }],
      },
    });
    toBacklog.mockReturnValueOnce({
      items: [{ id: 'build-item', phase_id: 'build', status: 'in_progress' }],
    });

    await expect(createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      title: 'Disguised research plan',
      steps: [{
        title: 'Inspect current implementation',
        type: 'task',
        role: 'investigate',
        instructions: 'Keep looking for possible errors.',
      }],
    })).rejects.toThrow('Standalone research step');

    expect(builder.insert).not.toHaveBeenCalled();
  });

  it('allows bounded research for a genuinely blocking build unknown', async () => {
    resolveBacklogContextForInstance.mockResolvedValueOnce({
      requirementId: REQUIREMENT_ID,
      inProgressItemId: 'build-item',
    });
    loadRequirement.mockResolvedValueOnce({
      backlog: {
        items: [{ id: 'build-item', phase_id: 'build', status: 'in_progress' }],
      },
    });
    toBacklog.mockReturnValueOnce({
      items: [{ id: 'build-item', phase_id: 'build', status: 'in_progress' }],
    });
    mockSuccessfulInsert();

    await createInstancePlanCore({
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      user_id: USER_ID,
      requirement_id: REQUIREMENT_ID,
      title: 'Bounded research plan',
      steps: [{
        title: 'Determine provider API compatibility',
        type: 'research',
        instructions: 'Identify the supported API version.',
        expected_output: 'A provider compatibility decision.',
        success_criteria: ['The supported version is identified.'],
        metadata: { blocking_unknown: 'The provider API version is unknown.' },
      }],
    });

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            role: 'investigate',
            skill: 'makinari-fase-investigacion',
          }),
        ],
      }),
    );
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
