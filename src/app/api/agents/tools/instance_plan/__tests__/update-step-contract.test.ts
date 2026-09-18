const single = jest.fn();
const builder: Record<string, jest.Mock> = {};
builder.select = jest.fn(() => builder);
builder.eq = jest.fn(() => builder);
builder.update = jest.fn(() => builder);
builder.single = single;
const from = jest.fn(() => builder);

const resolveBacklogContextForInstance = jest.fn();
const loadRequirement = jest.fn();
const toBacklog = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));
jest.mock('@/lib/services/requirement-backlog', () => ({
  resolveBacklogContextForInstance,
}));
jest.mock('@/lib/services/requirement-backlog-store', () => ({
  loadRequirement,
  toBacklog,
}));

import { updateInstancePlanCore } from '../update/route';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const REQUIREMENT_ID = '44444444-4444-4444-8444-444444444444';

function existingPlan(steps: any[] = []) {
  return {
    site_id: SITE_ID,
    instance_id: INSTANCE_ID,
    status: 'in_progress',
    updated_at: '2026-09-18T07:00:00.000Z',
    metadata: { requirement_id: REQUIREMENT_ID },
    steps,
  };
}

describe('updateInstancePlanCore step contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveBacklogContextForInstance.mockResolvedValue({
      requirementId: REQUIREMENT_ID,
      inProgressItemId: 'item-1',
    });
    loadRequirement.mockResolvedValue({
      backlog: { items: [{ id: 'item-1', phase_id: 'build' }] },
    });
    toBacklog.mockReturnValue({
      items: [{ id: 'item-1', phase_id: 'build' }],
    });
  });

  it('rejects an appended open-ended research step in build phase', async () => {
    single.mockResolvedValueOnce({
      data: existingPlan(),
      error: null,
    });

    await expect(updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{
        title: 'Investigate the current implementation',
        type: 'research',
        instructions: 'Keep inspecting possible problems.',
      }],
    })).rejects.toThrow('Standalone research step');

    expect(builder.update).not.toHaveBeenCalled();
  });

  it('normalizes an appended implementation step before persistence', async () => {
    single
      .mockResolvedValueOnce({
        data: existingPlan(),
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: PLAN_ID },
        error: null,
      });

    await updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{
        title: 'Implement contact form',
        type: 'task',
        instructions: 'Implement the real contact form.',
      }],
    });

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            expected_output: expect.stringContaining('Implement contact form'),
            success_criteria: expect.any(Array),
            validation_rules: expect.any(Array),
            metadata: expect.objectContaining({
              backlog_item_id: 'item-1',
            }),
          }),
        ],
      }),
    );
  });

  it('rejects an unknown explicit skill on an appended requirement step', async () => {
    single.mockResolvedValueOnce({
      data: existingPlan(),
      error: null,
    });

    await expect(updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{
        title: 'Implement contact form',
        type: 'task',
        skill: 'makinari-skill-that-does-not-exist',
        instructions: 'Implement the real contact form.',
      }],
    })).rejects.toThrow('unknown skill');

    expect(builder.update).not.toHaveBeenCalled();
  });

  it('preserves legacy empty contracts for status-only patches', async () => {
    const legacyStep = {
      id: 'step-1',
      order: 1,
      title: 'Legacy step',
      status: 'in_progress',
      expected_output: '',
      success_criteria: [],
      validation_rules: [],
      metadata: { backlog_item_id: 'item-1' },
    };
    single
      .mockResolvedValueOnce({
        data: existingPlan([legacyStep]),
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: PLAN_ID },
        error: null,
      });

    await updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{
        id: 'step-1',
        status: 'in_progress',
        actual_output: 'Still working.',
      }],
    });

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            expected_output: '',
            success_criteria: [],
            validation_rules: [],
          }),
        ],
      }),
    );
  });

  it('keeps completed steps fully immutable when status is omitted', async () => {
    const completedStep = {
      id: 'step-1',
      order: 1,
      title: 'Completed implementation',
      status: 'completed',
      actual_output: 'Verified output',
      completed_at: '2026-09-18T06:00:00.000Z',
      metadata: { backlog_item_id: 'item-1' },
    };
    single
      .mockResolvedValueOnce({
        data: existingPlan([completedStep]),
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: PLAN_ID },
        error: null,
      });

    await updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{
        id: 'step-1',
        title: 'Mutated title',
        actual_output: null,
        completed_at: null,
        backlog_item_id: 'foreign-item',
      }],
    });

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ steps: [completedStep] }),
    );
  });

  it('enforces requirement terminal protections for direct core calls', async () => {
    single.mockResolvedValueOnce({
      data: existingPlan([{ id: 'step-1', status: 'in_progress' }]),
      error: null,
    });

    await expect(updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{ id: 'step-1', status: 'completed' }],
    })).rejects.toThrow('runner-owned');

    expect(builder.update).not.toHaveBeenCalled();
  });

  it('infers requirement protection for legacy plans without metadata', async () => {
    single.mockResolvedValueOnce({
      data: {
        ...existingPlan([{ id: 'step-1', status: 'in_progress' }]),
        metadata: {},
      },
      error: null,
    });

    await expect(updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      status: 'cancelled',
    })).rejects.toThrow('runner-owned');

    expect(builder.update).not.toHaveBeenCalled();
  });

  it('revives a cancelled plan when adaptation appends a runnable replacement', async () => {
    single
      .mockResolvedValueOnce({
        data: {
          ...existingPlan([{ id: 'step-1', status: 'cancelled' }]),
          status: 'cancelled',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: PLAN_ID },
        error: null,
      });

    await updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      steps: [{
        title: 'Implement replacement',
        type: 'task',
        instructions: 'Implement the replacement.',
      }],
    });

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'in_progress',
        completed_at: null,
      }),
    );
  });

  it('rejects a stale whole-plan update instead of overwriting concurrent progress', async () => {
    single
      .mockResolvedValueOnce({
        data: existingPlan([{ id: 'step-1', status: 'in_progress' }]),
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'The result contains 0 rows' },
      });

    await expect(updateInstancePlanCore({
      plan_id: PLAN_ID,
      instance_id: INSTANCE_ID,
      site_id: SITE_ID,
      title: 'Concurrent edit',
    })).rejects.toThrow('changed concurrently');

    expect(builder.eq).toHaveBeenCalledWith(
      'updated_at',
      '2026-09-18T07:00:00.000Z',
    );
  });
});
