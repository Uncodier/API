import {
  closeSupersededPlan,
  isStrictFinalPlanStep,
  summarizePlanSteps,
} from '../plan-status';

describe('summarizePlanSteps', () => {
  it('only completes a plan when every step completed', () => {
    expect(summarizePlanSteps([
      { status: 'completed' },
      { status: 'completed' },
    ])).toMatchObject({
      status: 'completed',
      completedCount: 2,
      progressPercentage: 100,
    });

    expect(summarizePlanSteps([
      { status: 'completed' },
      { status: 'pending' },
    ])).toMatchObject({
      status: 'in_progress',
      completedCount: 1,
      progressPercentage: 50,
    });
  });

  it('reconciles terminal cancelled and failed plans', () => {
    expect(summarizePlanSteps([
      { status: 'completed' },
      { status: 'cancelled' },
    ]).status).toBe('cancelled');

    expect(summarizePlanSteps([
      { status: 'cancelled' },
      { status: 'failed', retry_count: 2 },
    ]).status).toBe('failed');
  });

  it('keeps a failed step runnable while retries remain', () => {
    expect(summarizePlanSteps([
      { status: 'failed', retry_count: 1 },
    ]).status).toBe('in_progress');
  });

  it('keeps replacement work runnable after an earlier step is cancelled', () => {
    expect(summarizePlanSteps([
      { status: 'cancelled' },
      { status: 'pending' },
    ])).toMatchObject({
      status: 'in_progress',
      hasRunnable: true,
    });
  });
});

describe('isStrictFinalPlanStep', () => {
  it('requires every sibling step to be completed', () => {
    expect(isStrictFinalPlanStep([
      { id: 'step-1', status: 'completed' },
      { id: 'step-2', status: 'in_progress' },
    ], 'step-2')).toBe(true);

    for (const status of ['pending', 'in_progress', 'failed', 'cancelled']) {
      expect(isStrictFinalPlanStep([
        { id: 'step-1', status },
        { id: 'step-2', status: 'in_progress' },
      ], 'step-2')).toBe(false);
    }
  });

  it('rejects missing or duplicate current step ids', () => {
    expect(isStrictFinalPlanStep([], 'step-1')).toBe(false);
    expect(isStrictFinalPlanStep([
      { id: 'step-1', status: 'in_progress' },
      { id: 'step-1', status: 'completed' },
    ], 'step-1')).toBe(false);
  });
});

describe('closeSupersededPlan', () => {
  const now = '2026-09-16T03:30:00.000Z';

  it('cancels unfinished steps instead of reporting false completion', () => {
    const result = closeSupersededPlan(
      [
        { id: 'done', status: 'completed' },
        { id: 'active', status: 'in_progress' },
        { id: 'queued', status: 'pending' },
      ],
      'Superseded by a new plan',
      now,
    );

    expect(result.status).toBe('cancelled');
    expect(result.completedCount).toBe(1);
    expect(result.steps.map((step) => step.status)).toEqual([
      'completed',
      'cancelled',
      'cancelled',
    ]);
    expect(result.steps[1]).toMatchObject({
      cancellation_reason: 'Superseded by a new plan',
      cancelled_at: now,
    });
  });

  it('preserves completed status when every step already completed', () => {
    const steps = [{ id: 'one', status: 'completed' }];
    expect(closeSupersededPlan(steps, 'Superseded', now)).toEqual({
      status: 'completed',
      steps,
      completedCount: 1,
      progressPercentage: 100,
    });
  });
});
