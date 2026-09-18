import {
  VisitorIdentityError,
  identityErrorBody,
  maskIdentityEmail,
  normalizeIdentityEmail
} from '../contracts';

describe('visitor identity contracts', () => {
  it('normalizes and masks email addresses without exposing the local part', () => {
    expect(normalizeIdentityEmail(' Person@Example.COM ')).toBe('person@example.com');
    expect(maskIdentityEmail('person@example.com')).toBe('pe****@example.com');
  });

  it('uses the required structured error envelope', () => {
    expect(identityErrorBody(new VisitorIdentityError('rate_limited', 'Wait', 429, 60))).toEqual({
      success: false,
      error: { code: 'rate_limited', message: 'Wait', retry_after: 60 }
    });
  });

  it('does not expose unexpected error details', () => {
    expect(identityErrorBody(new Error('database password'))).toEqual({
      success: false,
      error: { code: 'internal_error', message: 'Unable to process identity request' }
    });
  });
});
