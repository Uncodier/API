import {
  isNoProgressAdjudicationRequested,
  shouldHoldNoProgressBlock,
} from '../no-progress-adjudication';

describe('no-progress step adjudication', () => {
  it('recognizes only a requested adjudication', () => {
    expect(isNoProgressAdjudicationRequested({
      metadata: {
        no_progress_adjudication: {
          state: 'requested',
          execution_generation: 4,
        },
      },
    }, 4)).toBe(true);
    expect(isNoProgressAdjudicationRequested({
      metadata: {
        no_progress_adjudication: {
          state: 'consumed',
          execution_generation: 4,
        },
      },
    }, 4)).toBe(false);
    expect(isNoProgressAdjudicationRequested({
      metadata: {
        no_progress_adjudication: {
          state: 'requested',
          execution_generation: 3,
        },
      },
    }, 4)).toBe(false);
  });

  it('holds the blocker until adjudication is consumed', () => {
    expect(shouldHoldNoProgressBlock(undefined)).toBe(true);
    expect(shouldHoldNoProgressBlock('requested')).toBe(true);
    expect(shouldHoldNoProgressBlock('retryable')).toBe(true);
    expect(shouldHoldNoProgressBlock('consumed')).toBe(false);
  });
});
