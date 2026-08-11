import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify Supabase Auth Send Email Hook (Standard Webhooks) signature.
 * Secret format: "v1,whsec_<base64>" or raw base64.
 */
export function verifyStandardWebhook(params: {
  body: string;
  headers: Headers | Record<string, string | null | undefined>;
  secret: string;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; error: string } {
  const { body, secret, toleranceSeconds = 300 } = params;
  const getHeader = (name: string): string | null => {
    if (typeof (params.headers as Headers).get === 'function') {
      return (params.headers as Headers).get(name);
    }
    const rec = params.headers as Record<string, string | null | undefined>;
    return (
      rec[name] ??
      rec[name.toLowerCase()] ??
      rec[name.toUpperCase()] ??
      null
    );
  };

  const msgId = getHeader('webhook-id');
  const timestamp = getHeader('webhook-timestamp');
  const signatureHeader = getHeader('webhook-signature');

  if (!msgId || !timestamp || !signatureHeader) {
    return { ok: false, error: 'Missing webhook signature headers' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'Invalid webhook timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { ok: false, error: 'Webhook timestamp outside tolerance' };
  }

  let key = secret.trim();
  if (key.startsWith('v1,whsec_')) key = key.slice('v1,whsec_'.length);
  else if (key.startsWith('whsec_')) key = key.slice('whsec_'.length);

  const secretBytes = Buffer.from(key, 'base64');
  const toSign = `${msgId}.${timestamp}.${body}`;
  const expected = createHmac('sha256', secretBytes).update(toSign).digest('base64');

  const signatures = signatureHeader.split(' ').map((part) => {
    const [version, value] = part.split(',', 2);
    return { version, value };
  });

  const matched = signatures.some(({ version, value }) => {
    if (version !== 'v1' || !value) return false;
    try {
      const a = Buffer.from(value);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });

  if (!matched) {
    return { ok: false, error: 'Invalid webhook signature' };
  }

  return { ok: true };
}
