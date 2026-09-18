import {
  generateOtpCode,
  hashIdentityRateLimitValue,
  hashOtp,
  otpHashesEqual
} from '../otp-crypto';

const context = {
  challengeId: '11111111-1111-4111-8111-111111111111',
  siteId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  visitorId: '44444444-4444-4444-8444-444444444444',
  leadId: '55555555-5555-4555-8555-555555555555',
  normalizedEmail: 'person@example.com'
};

describe('visitor identity OTP crypto', () => {
  beforeEach(() => {
    process.env.VISITOR_IDENTITY_OTP_HMAC_SECRET = 'a-secure-test-secret-with-at-least-32-characters';
  });

  afterEach(() => {
    delete process.env.VISITOR_IDENTITY_OTP_HMAC_SECRET;
  });

  it('generates exactly six numeric digits', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('binds the HMAC to the complete identity context', () => {
    const first = hashOtp('123456', context);
    const second = hashOtp('123456', { ...context, sessionId: '66666666-6666-4666-8666-666666666666' });
    expect(first).not.toBe(second);
    expect(otpHashesEqual(first, hashOtp('123456', context))).toBe(true);
    expect(otpHashesEqual(first, second)).toBe(false);
  });

  it('rejects weak or missing secrets', () => {
    process.env.VISITOR_IDENTITY_OTP_HMAC_SECRET = 'short';
    expect(() => hashOtp('123456', context)).toThrow(/at least 32/);
    expect(() => hashIdentityRateLimitValue('127.0.0.1')).toThrow(/at least 32/);
  });

  it('rejects malformed codes and hashes', () => {
    expect(() => hashOtp('12345', context)).toThrow(/six digits/);
    expect(otpHashesEqual('not-a-hash', 'also-not-a-hash')).toBe(false);
  });
});
