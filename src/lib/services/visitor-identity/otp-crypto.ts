import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { IdentityContext } from './contracts';

const MIN_SECRET_LENGTH = 32;

function getSecret(): string {
  const secret = process.env.VISITOR_IDENTITY_OTP_HMAC_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`VISITOR_IDENTITY_OTP_HMAC_SECRET must contain at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

function serializeContext(context: IdentityContext): string {
  return JSON.stringify([
    'visitor-identity-otp-v1',
    context.challengeId,
    context.siteId,
    context.sessionId,
    context.visitorId,
    context.leadId,
    context.normalizedEmail
  ]);
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtp(code: string, context: IdentityContext): string {
  if (!/^\d{6}$/.test(code)) {
    throw new Error('OTP code must contain exactly six digits');
  }
  return createHmac('sha256', getSecret())
    .update(serializeContext(context))
    .update('\0')
    .update(code)
    .digest('hex');
}

export function otpHashesEqual(expectedHex: string, candidateHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedHex) || !/^[a-f0-9]{64}$/i.test(candidateHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(candidateHex, 'hex'));
}

export function hashIdentityRateLimitValue(value: string): string {
  return createHmac('sha256', getSecret())
    .update('visitor-identity-rate-limit-v1\0')
    .update(value)
    .digest('hex');
}
