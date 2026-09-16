import { closeSupersededPlan, summarizePlanSteps } from '../plan-status';

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
