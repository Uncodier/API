import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies `x-vercel-signature` (HMAC-SHA1 over the raw request body, hex-encoded).
 * See https://vercel.com/docs/webhooks/webhooks-api#securing-webhooks
 *
 * Configure the same secret in the Vercel dashboard and in VERCEL_WEBHOOK_SECRET.
 */
export function verifyVercelWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!secret) return false;

  const expected = createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex');
  // Vercel sends the digest as plain hex (no "sha1=" prefix); tolerate either form.
  const received = signatureHeader.startsWith('sha1=')
    ? signatureHeader.slice('sha1='.length)
    : signatureHeader;

  const sigBuf = Buffer.from(received, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
