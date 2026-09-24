import { applyBacklogStatusLifecycle } from '../requirement-review-quarantine';

describe('review quarantine lifecycle', () => {
  it('records the release watermark and durable cancellation request', () => {
    const result = applyBacklogStatusLifecycle({
      item: {
        id: 'review-item',
        title: 'Landing page',
        kind: 'page',
        phase_id: 'build',
        acceptance: ['GET / returns 200'],
        status: 'judge_review',
        attempts: 4,
        scope_level: 'minimal',
      },
      status: 'needs_review',
      reason: 'Capability gap: no authenticated probe profile',
      externalActionRevision: 7,
      now: '2026-09-23T22:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'needs_review',
      review_quarantine: {
        active: true,
        kind: 'capability_gap',
        reason: 'Capability gap: no authenticated probe profile',
        quarantined_at: '2026-09-23T22:00:00.000Z',
        external_action_revision: 7,
      },
      plan_cancellation_pending: {
        reason: expect.stringContaining('needs_review'),
        requested_at: '2026-09-23T22:00:00.000Z',
      },
    }));
  });
});
