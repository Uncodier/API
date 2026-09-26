import { recoveryAfterUnhandledError } from '../cycle-recovery-policy';

describe('typed cycle recovery policy', () => {
  it.each(['idle', 'progress', 'infrastructure_retry', 'infrastructure_wait'] as const)(
    'keeps infrastructure errors retryable after %s', outcome => {
      expect(recoveryAfterUnhandledError(outcome)).toEqual({
        outcome: 'infrastructure_retry', disposition: 'retry',
      });
    },
  );

  it('preserves the exhausted infrastructure circuit', () => {
    expect(recoveryAfterUnhandledError('infrastructure_exhausted')).toEqual({
      outcome: 'infrastructure_exhausted', disposition: 'blocked',
    });
  });

  it('keeps product retry policy separate from infrastructure accounting', () => {
    expect(recoveryAfterUnhandledError('product_failure')).toEqual({
      outcome: 'product_failure', disposition: 'product_failure',
    });
  });
});