import { describe, expect, it } from '@jest/globals';
import { detectUnhealthyOnReview, requirementStatusAfterSaneo } from '@/lib/services/requirement-onreview-sanitizer';

function item(partial: Record<string, unknown>) {
  return {
    id: 'item-1',
    title: 'Research',
    status: 'in_progress',
    tier: 'core',
    assumptions: [],
    tool_failures: {},
    touches: [],
    ...partial,
  };
}

describe('detectUnhealthyOnReview', () => {
  it('ignores unknown / instance_plan / execute_step as infra', () => {
    const plan = detectUnhealthyOnReview({
      backlog: {
        items: [
          item({
            tool_failures: { unknown: 3, instance_plan: 1, execute_step: 1 },
          }),
        ],
      },
    });
    expect(plan.needsSanitization).toBe(false);
  });

  it('does not treat docs progress as stuck plumbing', () => {
    const plan = detectUnhealthyOnReview({
      backlog: {
        items: [
          item({
            tool_failures: { sandbox: 2 },
            touches: ['docs/gtm-channels-blueprint.md'],
          }),
        ],
      },
    });
    expect(plan.needsSanitization).toBe(false);
  });

  it('reopens real plumbing-stuck items to pending, not needs_review on first hit', () => {
    const plan = detectUnhealthyOnReview({
      backlog: {
        items: [
          item({
            tool_failures: { sandbox: 2 },
            assumptions: ['[plumbing] serialization'],
          }),
        ],
      },
    });
    expect(plan.needsSanitization).toBe(true);
    expect(plan.itemsToReopen[0].targetStatus).toBe('pending');
  });

  it('parks the requirement on-review when nothing is left runnable', () => {
    expect(requirementStatusAfterSaneo([{ status: 'needs_review' }, { status: 'done' }])).toEqual({
      status: 'on-review',
      stage: 'needs_review',
    });
    expect(requirementStatusAfterSaneo([{ status: 'pending' }, { status: 'needs_review' }])).toEqual({
      status: 'in-progress',
      stage: 'in-progress',
    });
  });
});
