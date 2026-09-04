import { applyItemExhaustionToSteps, planCancelledBySaneo } from '../plan-lifecycle';

describe('applyItemExhaustionToSteps', () => {
  const item = 'item-a';
  const now = '2026-09-04T00:00:00.000Z';

  it('cancels failed and in_progress for the exhausted item and keeps pending ones', () => {
    const { nextSteps, stepsCancelled, stillRunnable } = applyItemExhaustionToSteps(
      [
        { id: 's1', status: 'failed', metadata: { backlog_item_id: item } },
        { id: 's2', status: 'in_progress', metadata: { backlog_item_id: item } },
        { id: 's3', status: 'pending', metadata: { backlog_item_id: item } },
      ],
      item,
      'attempts exhausted',
      now,
    );
    expect(stepsCancelled).toBe(2);
    expect(nextSteps.find((s) => s.id === 's1')?.status).toBe('cancelled');
    expect(nextSteps.find((s) => s.id === 's2')?.status).toBe('cancelled');
    expect(nextSteps.find((s) => s.id === 's3')?.status).toBe('pending');
    expect(stillRunnable).toBe(true);
  });

  it('does not cancel the plan when later pending steps remain', () => {
    const { stillRunnable, stepsCancelled, nextSteps } = applyItemExhaustionToSteps(
      [
        { id: 's1', status: 'failed', metadata: { backlog_item_id: item } },
        { id: 's2', status: 'pending', metadata: { backlog_item_id: item } },
      ],
      item,
      'attempts exhausted',
      now,
    );
    expect(stepsCancelled).toBe(1);
    expect(nextSteps.find((s) => s.id === 's2')?.status).toBe('pending');
    expect(stillRunnable).toBe(true);
  });

  it('leaves other items\' steps alone', () => {
    const { nextSteps, stillRunnable } = applyItemExhaustionToSteps(
      [
        { id: 's1', status: 'in_progress', metadata: { backlog_item_id: item } },
        { id: 's2', status: 'pending', metadata: { backlog_item_id: 'item-b' } },
      ],
      item,
      'attempts exhausted',
      now,
    );
    expect(nextSteps.find((s) => s.id === 's2')?.status).toBe('pending');
    expect(stillRunnable).toBe(true);
  });

  it('detects saneo cancel from completion_reason, not only metadata', () => {
    expect(
      planCancelledBySaneo({
        status: 'cancelled',
        metadata: {},
        completion_reason: 'Backlog item x reached terminal state — [auto-saneo] Cancelling plans',
      }),
    ).toBe(true);
    expect(planCancelledBySaneo({ status: 'cancelled', metadata: {}, completion_reason: 'user cancelled' })).toBe(false);
  });
});
