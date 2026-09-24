import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('durable review quarantine PostgreSQL behavior', () => {
  it('requires a newer trusted action and consumes it once', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        resolve(
          process.cwd(),
          'src/lib/services/__tests__/review-quarantine-postgres-runner.mjs',
        ),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output);
    const backfilledItem = result.backfilled.backlog.items[0];
    const releasedItem = result.released.backlog.items[0];
    const lateItemBefore = result.lateRequirementBefore.backlog.items[0];
    const lateItemAfter = result.lateRequirementAfter.backlog.items[0];

    expect(backfilledItem.review_quarantine).toMatchObject({
      active: true,
      external_action_revision: 0,
    });
    expect(result.backfilled.backlog_revision).toBe(1);
    expect(result.directReopenRejected).toBe(true);
    expect(result.untrusted).toMatchObject({
      state: 'untrusted',
      reopened_item_ids: [],
      external_user_action_revision: 0,
    });
    expect(result.release).toMatchObject({
      state: 'applied',
      reopened_item_ids: ['item-1'],
      external_user_action_revision: 1,
    });
    expect(releasedItem).toMatchObject({
      status: 'pending',
      attempts: 0,
      tool_failures: { sandbox_db_migrate: 1 },
      review_quarantine: {
        active: false,
        released_by_action_id:
          '40000000-0000-4000-8000-000000000004',
      },
    });
    expect(result.released).toMatchObject({
      backlog_revision: 2,
      external_user_action_revision: 1,
      last_external_user_action_id:
        '40000000-0000-4000-8000-000000000004',
    });
    expect(result.duplicate).toMatchObject({
      state: 'duplicate',
      reopened_item_ids: [],
      external_user_action_revision: 1,
    });
    expect(result.nextAction).toMatchObject({
      state: 'applied',
      reopened_item_ids: [],
      external_user_action_revision: 2,
    });
    expect(result.replayAfterNewerAction).toMatchObject({
      state: 'duplicate',
      reopened_item_ids: [],
      external_user_action_revision: 2,
    });
    expect(result.oldAction).toMatchObject({
      state: 'applied',
      reopened_item_ids: [],
      external_user_action_revision: 1,
    });
    expect(lateItemBefore).toMatchObject({
      status: 'needs_review',
      review_quarantine: { active: true },
    });
    expect(result.lateRelease).toMatchObject({
      state: 'applied',
      reopened_item_ids: ['late-item'],
    });
    expect(lateItemAfter).toMatchObject({
      status: 'pending',
      review_quarantine: {
        active: false,
        released_by_action_id:
          '70000000-0000-4000-8000-000000000007',
      },
    });
    expect(result.internalRecovery).toMatchObject({
      state: 'applied',
      reopened_item_ids: [],
      external_user_action_revision: 0,
    });
    expect(result.stamped.backlog.items[0]).toMatchObject({
      status: 'needs_review',
      review_quarantine: {
        active: true,
        external_action_revision: 0,
      },
      plan_cancellation_pending: expect.any(Object),
    });
  });
});
