import {
  findRequirementPlan,
  hasOnlyRetryableStepFailures,
  hasRunnablePlanWork,
} from '../cycle-wrapup-retry-policy';

describe('cycle wrap-up retry policy', () => {
  it('continues when every failed step still has retries', () => {
    expect(hasOnlyRetryableStepFailures([
      { status: 'completed' },
      { status: 'failed', retry_count: 1 },
      { status: 'pending' },
    ])).toBe(true);
  });

  it('requires intervention when any failed step exhausted retries', () => {
    expect(hasOnlyRetryableStepFailures([
      { status: 'failed', retry_count: 1 },
      { status: 'failed', retry_count: 2 },
      { status: 'pending' },
    ])).toBe(false);
  });

  it('does not classify an ordinary pending plan as a retry failure', () => {
    expect(hasOnlyRetryableStepFailures([
      { status: 'pending' },
    ])).toBe(false);
  });

  it('recognizes pending, in-progress, and retryable failed work', () => {
    expect(hasRunnablePlanWork([{ status: 'pending' }])).toBe(true);
    expect(hasRunnablePlanWork([{ status: 'in_progress' }])).toBe(true);
    expect(hasRunnablePlanWork([
      { status: 'failed', retry_count: 1 },
    ])).toBe(true);
    expect(hasRunnablePlanWork([
      { status: 'failed', retry_count: 2 },
    ])).toBe(false);
  });

  it('does not select unrelated generic plans for requirement recovery', () => {
    const generic = {
      steps: [{
        status: 'failed',
        retry_count: 1,
        metadata: { backlog_item_id: 'other-item' },
      }],
    };
    const requirementPlan = {
      metadata: { requirement_id: 'req-1' },
      steps: [{ status: 'failed', retry_count: 1 }],
    };

    expect(findRequirementPlan(
      [generic, requirementPlan],
      'req-1',
      new Set(['req-item']),
    )).toBe(requirementPlan);
    expect(findRequirementPlan(
      [generic],
      'req-1',
      new Set(['req-item']),
    )).toBeUndefined();
  });

  it('finds a legacy requirement plan through backlog item ownership', () => {
    const legacyPlan = {
      steps: [{
        status: 'failed',
        retry_count: 1,
        metadata: { backlog_item_id: 'req-item' },
      }],
    };

    expect(findRequirementPlan(
      [legacyPlan],
      'req-1',
      new Set(['req-item']),
    )).toBe(legacyPlan);
  });
});
