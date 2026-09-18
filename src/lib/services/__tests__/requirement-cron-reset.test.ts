jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

import { reopenReviewBacklogOnUserAction } from '../requirement-cron-reset';

describe('requirement recovery after user feedback', () => {
  it('requeues review items with a fresh failure budget', () => {
    const result = reopenReviewBacklogOnUserAction({
      schema_version: 1,
      current_phase_id: 'report',
      completion_ratio: 0,
      cycles_spent_total: 0,
      items: [
        {
          id: 'review-item',
          title: 'Landing page',
          kind: 'page',
          phase_id: 'build',
          acceptance: ['GET / returns 200'],
          status: 'needs_review',
          attempts: 4,
          scope_level: 'minimal',
          tier: 'core',
        },
        {
          id: 'done-item',
          title: 'Setup',
          kind: 'component',
          phase_id: 'setup',
          acceptance: ['Setup renders'],
          status: 'done',
          attempts: 1,
          scope_level: 'full',
          tier: 'core',
        },
      ],
    });

    expect(result.reopenedItemIds).toEqual(['review-item']);
    expect(result.backlog).toEqual(expect.objectContaining({
      current_phase_id: 'build',
      completion_ratio: 0.5,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'review-item',
          status: 'pending',
          attempts: 0,
        }),
        expect.objectContaining({
          id: 'done-item',
          status: 'done',
          attempts: 1,
        }),
      ]),
    }));
  });
});
