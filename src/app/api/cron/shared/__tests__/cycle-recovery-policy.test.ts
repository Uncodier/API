import { cycleFailureReason, recoveryAfterUnhandledError } from '../cycle-recovery-policy';

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

  it('preserves primary product evidence rather than a secondary ownership wrapper', () => {
    const reason = 'POST /api/drivers/register ->400 invalid nested payload; product budget exhausted after 3';
    expect(cycleFailureReason('product_failure', reason, new Error('exceeded max retries'))).toBe(reason);
  });

  it('does not hide new infrastructure failure behind earlier progress', () => {
    expect(cycleFailureReason('progress', 'Earlier progress', new Error('database unavailable')))
      .toContain('database unavailable');
  });
});