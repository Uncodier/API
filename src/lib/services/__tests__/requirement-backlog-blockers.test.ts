import {
  addDirectBacklogBlocker,
  isBacklogItemRunnable,
  reconcileBacklogBlockedBy,
  releaseDueAutomaticBlockers,
  removeDirectBacklogBlocker,
  requiresUserAction,
} from '../requirement-backlog-blockers';
import type { BacklogItem } from '../requirement-backlog-types';

function item(
  id: string,
  dependsOn: string[] = [],
  status: BacklogItem['status'] = 'pending',
): BacklogItem {
  return {
    id,
    title: id,
    kind: 'subtask',
    phase_id: 'build',
    acceptance: [`GET /${id} returns 200`],
    status,
    attempts: 0,
    scope_level: 'full',
    depends_on: dependsOn,
  };
}

describe('backlog blocker propagation', () => {
  it('propagates a direct blocker only to dependency descendants', () => {
    const source = item('source');
    const child = item('child', ['source']);
    const grandchild = item('grandchild', ['child']);
    const independent = item('independent');
    addDirectBacklogBlocker(source, {
      blocker_id: 'preview-missing',
      category: 'missing_precondition',
      reason: 'Preview URL is unavailable.',
      resolution_actor: 'platform',
      source_item_id: source.id,
      user_action_required: false,
    });

    reconcileBacklogBlockedBy([source, child, grandchild, independent]);

    expect(source.blocked_by).toEqual([
      expect.objectContaining({ blocker_id: 'preview-missing' }),
    ]);
    expect(child.blocked_by).toEqual([
      expect.objectContaining({
        blocker_id: 'preview-missing',
        propagated_from_item_id: 'source',
      }),
    ]);
    expect(grandchild.blocked_by).toEqual([
      expect.objectContaining({
        blocker_id: 'preview-missing',
        propagated_from_item_id: 'child',
      }),
    ]);
    expect(independent.blocked_by).toBeUndefined();
  });

  it('removes propagated blockers after the direct blocker is resolved', () => {
    const source = item('source');
    const child = item('child', ['source']);
    addDirectBacklogBlocker(source, {
      blocker_id: 'evidence-gap',
      category: 'evidence_gap',
      reason: 'Evidence receipt is missing.',
      resolution_actor: 'verifier',
    });
    reconcileBacklogBlockedBy([source, child]);

    removeDirectBacklogBlocker(source, 'evidence-gap');
    source.status = 'done';
    reconcileBacklogBlockedBy([source, child]);

    expect(source.blocked_by).toBeUndefined();
    expect(child.blocked_by).toBeUndefined();
  });

  it('does not call blocked work runnable', () => {
    const blocked = item('blocked');
    addDirectBacklogBlocker(blocked, {
      blocker_id: 'decision',
      category: 'user_decision',
      reason: 'Choose a provider.',
      resolution_actor: 'user',
      user_action_required: true,
    });
    reconcileBacklogBlockedBy([blocked]);

    expect(
      isBacklogItemRunnable(blocked, new Set(), {
        core: 4,
        ornamental: 2,
      }),
    ).toBe(false);
    expect(requiresUserAction(blocked)).toBe(true);
  });

  it('materializes an unfinished dependency even without a direct blocker', () => {
    const source = item('source', [], 'in_progress');
    const child = item('child', ['source']);

    reconcileBacklogBlockedBy([source, child]);

    expect(child.blocked_by).toEqual([
      expect.objectContaining({
        blocker_id: 'dependency:source',
        category: 'dependency',
        source_item_id: 'source',
      }),
    ]);
  });

  it('never schedules an item with an active review quarantine', () => {
    const quarantined = item('quarantined');
    quarantined.review_quarantine = {
      active: true,
      kind: 'verification_exhausted',
      reason: 'Judge retry budget exhausted',
      quarantined_at: '2026-09-23T20:00:00.000Z',
      external_action_revision: 2,
    };

    expect(isBacklogItemRunnable(quarantined, new Set())).toBe(false);
  });

  it('releases only due platform blockers for an automatic retry', () => {
    const platform = item('platform');
    const executor = item('executor');
    const user = item('user');
    addDirectBacklogBlocker(platform, {
      blocker_id: 'platform-retry',
      category: 'infrastructure_unavailable',
      reason: 'Deployment unavailable.',
      resolution_actor: 'platform',
      retry_after: '2026-09-19T12:00:00.000Z',
    });
    addDirectBacklogBlocker(user, {
      blocker_id: 'user-decision',
      category: 'user_decision',
      reason: 'Choose a provider.',
      resolution_actor: 'user',
      retry_after: '2026-09-19T12:00:00.000Z',
    });
    addDirectBacklogBlocker(executor, {
      blocker_id: 'executor-retry',
      category: 'product_defect',
      reason: 'Replan after independent work.',
      resolution_actor: 'executor',
      retry_after: '2026-09-19T12:00:00.000Z',
    });

    expect(releaseDueAutomaticBlockers(
      [platform, executor, user],
      Date.parse('2026-09-19T12:01:00.000Z'),
    )).toEqual(['platform-retry', 'executor-retry']);
    expect(platform.blocked_by).toBeUndefined();
    expect(executor.blocked_by).toBeUndefined();
    expect(user.blocked_by).toEqual([
      expect.objectContaining({ blocker_id: 'user-decision' }),
    ]);
  });
});
