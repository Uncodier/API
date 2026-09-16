import { assertAgentBacklogTransitionAllowed } from '../agent-transition-policy';

describe('agent backlog transition policy', () => {
  it.each([
    { action: 'complete' },
    { action: 'mark_needs_review' },
    { action: 'set_status', status: 'done' as const },
    { action: 'set_status', status: 'rejected' as const },
    { action: 'set_status', status: 'needs_review' as const },
  ])('rejects runner-owned transition $action $status', (transition) => {
    expect(() => assertAgentBacklogTransitionAllowed(transition)).toThrow(
      'Backlog terminal transitions are runner-owned',
    );
  });

  it.each([
    { action: 'list' },
    { action: 'upsert' },
    { action: 'start' },
    { action: 'downgrade' },
    { action: 'log_assumption' },
    { action: 'set_status', status: 'pending' as const },
    { action: 'set_status', status: 'in_progress' as const },
    { action: 'set_status', status: 'critic_review' as const },
    { action: 'set_status', status: 'judge_review' as const },
  ])('allows non-terminal model transition $action $status', (transition) => {
    expect(() => assertAgentBacklogTransitionAllowed(transition)).not.toThrow();
  });
});
