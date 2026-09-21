import crypto from 'node:crypto';

export interface PublicImageSignatureInput {
  siteId: string;
  prompt: string;
  width: number;
  height: number;
}

export interface IssuedPublicImageSignature {
  expires: number;
  signature: string;
}

function signingSecret(): string {
  const value = (
    process.env.PUBLIC_MEDIA_SIGNING_SECRET
    || process.env.VISITOR_SESSION_TOKEN_SECRET
    || process.env.ENCRYPTION_KEY
  )?.trim();
  if (!value) {
    throw new Error('PUBLIC_MEDIA_SIGNING_SECRET is not configured');
  }
  return value;
}

function payload(input: PublicImageSignatureInput, expires: number): string {
  return JSON.stringify([
    'public-image',
    1,
    input.siteId,
    input.prompt,
    input.width,
    input.height,
    expires,
  ]);
}

function sign(input: PublicImageSignatureInput, expires: number): string {
  return crypto
    .createHmac('sha256', signingSecret())
    .update(payload(input, expires))
    .digest('hex');
}

export function issuePublicImageSignature(
  input: PublicImageSignatureInput,
  ttlSeconds = 10 * 60,
): IssuedPublicImageSignature {
  const boundedTtl = Math.min(15 * 60, Math.max(60, Math.trunc(ttlSeconds)));
  const expires = Math.floor(Date.now() / 1_000) + boundedTtl;
  return {
    expires,
    signature: sign(input, expires),
  };
}

export function verifyPublicImageSignature(
  input: PublicImageSignatureInput,
  expiresValue: string | null,
  suppliedSignature: string | null,
): boolean {
  if (!expiresValue || !suppliedSignature) return false;
  if (!/^[a-f0-9]{64}$/i.test(suppliedSignature)) return false;

  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1_000)) {
    return false;
  }

  const expected = Buffer.from(sign(input, expires), 'hex');
  const supplied = Buffer.from(suppliedSignature, 'hex');
  return supplied.length === expected.length
    && crypto.timingSafeEqual(supplied, expected);
}
