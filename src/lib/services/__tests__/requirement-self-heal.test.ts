import { planNextHealingAction } from '../requirement-self-heal';
import type { BacklogItem } from '../requirement-backlog-types';

function item(tier: BacklogItem['tier']): BacklogItem {
  return {
    id: 'item-1',
    title: 'Required landing page',
    kind: 'page',
    phase_id: 'build',
    acceptance: ['GET / returns 200 and renders the required content'],
    status: 'in_progress',
    attempts: 0,
    scope_level: 'minimal',
    tier,
  };
}

const verdict = {
  verdict: 'rejected' as const,
  reason: 'Required behavior is still missing.',
  matched_acceptance: [],
  unmatched_acceptance: ['GET / returns 200'],
};

describe('requirement self-healing', () => {
  it('keeps core acceptance mandatory on the third failure', () => {
    const action = planNextHealingAction({
      item: item('core'),
      verdict,
      attempts: 3,
    });

    expect(action).toEqual(expect.objectContaining({
      kind: 'rotate_strategy',
      hint: expect.stringContaining('Core acceptance remains mandatory'),
    }));
  });

  it('allows an ornamental item to document a third-attempt deferral', () => {
    const action = planNextHealingAction({
      item: item('ornamental'),
      verdict,
      attempts: 3,
    });

    expect(action.kind).toBe('log_assumption_and_continue');
  });

  it('still escalates unresolved core work for human review after four failures', () => {
    const action = planNextHealingAction({
      item: item('core'),
      verdict,
      attempts: 4,
    });

    expect(action.kind).toBe('mark_needs_review');
  });
});
