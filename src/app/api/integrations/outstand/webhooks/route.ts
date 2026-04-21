import { NextRequest, NextResponse } from 'next/server';
import { processOutstandWebhookPayload } from '@/lib/integrations/outstand/process-webhook';
import { verifyOutstandWebhookSignature } from '@/lib/integrations/outstand/webhook-verification';
import type { OutstandWebhookPayload } from '@/lib/integrations/outstand/webhook-types';

const KNOWN_EVENTS = new Set([
  'post.published',
  'post.error',
  'account.token_expired',
  'test',
]);

function isOutstandWebhookPayload(body: unknown): body is OutstandWebhookPayload {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (typeof o.event !== 'string' || !KNOWN_EVENTS.has(o.event)) return false;
  if (typeof o.timestamp !== 'string') return false;
  if (!o.data || typeof o.data !== 'object') return false;
  return true;
}

/**
 * POST https://backend.makinari.com/api/integrations/outstand/webhooks
 *
 * Events: post.published, post.error, account.token_expired (plus test from dashboard).
 * Optional: set OUTSTAND_WEBHOOK_SECRET and the same signing secret in Outstand.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.OUTSTAND_WEBHOOK_SECRET;
  const signature = request.headers.get('x-outstand-signature');

  if (secret) {
    if (!signature || !verifyOutstandWebhookSignature(rawBody, signature, secret)) {
      console.warn('[Outstand webhook] invalid or missing signature');
      return NextResponse.json(
        { success: false, error: 'Invalid signature' },
        { status: 401 }
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON' },
      { status: 400 }
    );
  }

  if (!isOutstandWebhookPayload(parsed)) {
    return NextResponse.json(
      { success: false, error: 'Invalid webhook payload' },
      { status: 400 }
    );
  }

  try {
    await processOutstandWebhookPayload(parsed);
    return NextResponse.json({ success: true, received: true, event: parsed.event });
  } catch (err) {
    console.error('[Outstand webhook] processing error:', err);
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
