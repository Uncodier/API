import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies `X-Outstand-Signature` (HMAC-SHA256 over the raw request body).
 * Configure the same secret in Outstand dashboard and `OUTSTAND_WEBHOOK_SECRET`.
 */
export function verifyOutstandWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected =
    'sha256=' +
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const sigBuf = Buffer.from(signatureHeader, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) {
    return false;
  }
  return timingSafeEqual(sigBuf, expBuf);
}
