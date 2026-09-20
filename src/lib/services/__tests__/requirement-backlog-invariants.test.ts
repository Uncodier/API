import {
  assertBacklogInvariants,
  assertBacklogStatusTransition,
} from '../requirement-backlog-invariants';
import type {
  BacklogItem,
  BacklogItemStatus,
} from '../requirement-backlog-types';

function item(
  id: string,
  dependsOn: string[] = [],
  status: BacklogItemStatus = 'pending',
): BacklogItem {
  return {
    id,
    title: id,
    kind: 'subtask',
    phase_id: 'implementation',
    acceptance: [`GET /${id} returns 200`],
    status,
    attempts: 0,
    scope_level: 'full',
    depends_on: dependsOn,
  };
}

describe('backlog graph invariants', () => {
  it('rejects duplicate item ids', () => {
    expect(() => assertBacklogInvariants([
      item('duplicate'),
      item('duplicate'),
    ])).toThrow(/duplicate item id "duplicate"/);
  });

  it('rejects an unknown dependency', () => {
    expect(() => assertBacklogInvariants([
      item('parent', ['missing']),
    ])).toThrow(/depends on unknown item "missing"/);
  });

  it('rejects a self dependency', () => {
    expect(() => assertBacklogInvariants([
      item('parent', ['parent']),
    ])).toThrow(/cannot depend on itself/);
  });

  it('rejects dependencies on a later phase', () => {
    const foundation = item('foundation');
    foundation.phase_id = 'foundation';
    const delivery = item('delivery');
    delivery.phase_id = 'delivery';

    expect(() => assertBacklogInvariants(
      [{ ...foundation, depends_on: ['delivery'] }, delivery],
      ['foundation', 'delivery'],
    )).toThrow(/cannot depend on later-phase item "delivery"/);
  });

  it('reports the dependency cycle path', () => {
    expect(() => assertBacklogInvariants([
      item('a', ['b']),
      item('b', ['c']),
      item('c', ['a']),
    ])).toThrow(/a -> b -> c -> a/);
  });

  it('accepts a valid DAG whose active item has completed dependencies', () => {
    expect(() => assertBacklogInvariants([
      item('foundation', [], 'done'),
      item('api', ['foundation'], 'done'),
      item('page', ['foundation', 'api'], 'judge_review'),
    ])).not.toThrow();
  });

  it('rejects skipping directly from pending to review', () => {
    expect(() => assertBacklogStatusTransition(
      [item('work')],
      'work',
      'judge_review',
    )).toThrow(/from pending to judge_review/);
  });

  it('rejects completing an item while a dependency is unfinished', () => {
    expect(() => assertBacklogStatusTransition(
      [
        item('dependency'),
        item('work', ['dependency'], 'in_progress'),
      ],
      'work',
      'done',
    )).toThrow(/dependencies are not done/);
  });

  it('rejects starting an item with an explicit blocker', () => {
    const blocked = item('blocked');
    blocked.blocked_by = [{
      blocker_id: 'missing-secret',
      category: 'missing_precondition',
      reason: 'A required secret is unavailable.',
      resolution_actor: 'user',
      user_action_required: true,
    }];

    expect(() => assertBacklogStatusTransition(
      [blocked],
      'blocked',
      'in_progress',
    )).toThrow(/blocked_by is not empty/);
  });
});
