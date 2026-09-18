import {
  isNoProgressAdjudicationRequested,
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

});
