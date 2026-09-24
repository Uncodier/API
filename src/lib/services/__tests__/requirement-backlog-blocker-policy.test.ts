import {
  assertBacklogBlockerCanBeResolved,
  assertBacklogItemCanBeBlocked,
} from '../requirement-backlog-blocker-policy';
import type {
  BacklogBlocker,
  BacklogItem,
} from '../requirement-backlog-types';

const item = (status: BacklogItem['status']): BacklogItem => ({
  id: 'item-1',
  title: 'Item',
  kind: 'page',
  phase_id: 'build',
  acceptance: ['GET / returns 200'],
  status,
  attempts: 0,
  scope_level: 'full',
});

const blocker = (
  resolutionActor: BacklogBlocker['resolution_actor'],
): BacklogBlocker => ({
  blocker_id: 'blocker-1',
  category: 'missing_precondition',
  reason: 'Needs resolution',
  resolution_actor: resolutionActor,
});

describe('backlog blocker trust policy', () => {
  it.each(['done', 'rejected', 'needs_review'] as const)(
    'does not let blocker attachment reopen %s work',
    (status) => {
      expect(() => assertBacklogItemCanBeBlocked(item(status)))
        .toThrow('terminal or quarantined');
    },
  );

  it('also honors active quarantine independently of status', () => {
    const quarantined = item('pending');
    quarantined.review_quarantine = {
      active: true,
      kind: 'capability_gap',
      reason: 'Missing auth profile',
      quarantined_at: '2026-09-23T20:00:00.000Z',
      external_action_revision: 3,
    };
    expect(() => assertBacklogItemCanBeBlocked(quarantined))
      .toThrow('terminal or quarantined');
  });

  it('does not let an agent resolve user or platform blockers', () => {
    expect(() => assertBacklogBlockerCanBeResolved(blocker('user'), 'agent'))
      .toThrow('external user action');
    expect(() => assertBacklogBlockerCanBeResolved(
      blocker('platform'),
      'agent',
    )).toThrow('platform-owned');
  });

  it('allows the owning trust domain to resolve a blocker', () => {
    expect(() => assertBacklogBlockerCanBeResolved(blocker('user'), 'user'))
      .not.toThrow();
    expect(() => assertBacklogBlockerCanBeResolved(
      blocker('platform'),
      'platform',
    )).not.toThrow();
    expect(() => assertBacklogBlockerCanBeResolved(
      blocker('verifier'),
      'agent',
    )).not.toThrow();
  });
});
