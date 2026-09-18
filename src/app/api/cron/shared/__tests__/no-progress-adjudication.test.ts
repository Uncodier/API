import {
  isNoProgressAdjudicationRequested,
} from '../no-progress-adjudication';

describe('no-progress step adjudication', () => {
  it('recognizes only a requested adjudication', () => {
    expect(isNoProgressAdjudicationRequested({
      metadata: { no_progress_adjudication: { state: 'requested' } },
    })).toBe(true);
    expect(isNoProgressAdjudicationRequested({
      metadata: { no_progress_adjudication: { state: 'consumed' } },
    })).toBe(false);
  });

});
