import { NextRequest, NextResponse } from 'next/server';
import { processOutstandWebhookPayload } from '@/lib/integrations/outstand/process-webhook';
import { verifyOutstandWebhookSignature } from '@/lib/integrations/outstand/webhook-verification';
import type { OutstandWebhookPayload } from '@/lib/integrations/outstand/webhook-types';
import { sha256 } from '@/lib/security/upstash-rest';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
  type ProviderWebhookClaim,
} from '@/lib/services/provider-webhook-claims';

const KNOWN_EVENTS = new Set([
  'post.published',
  'post.error',
  'account.token_expired',
  'conversation.started',
  'message.received',
  'message.sent',
  'message.failed',
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
 * Events: publishing, account, and Conversations API lifecycle events.
 * Optional: set OUTSTAND_WEBHOOK_SECRET and the same signing secret in Outstand.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.OUTSTAND_WEBHOOK_SECRET;
  const signature = request.headers.get('x-outstand-signature');

  if (!secret) {
    console.error('[Outstand webhook] OUTSTAND_WEBHOOK_SECRET is not configured');
    return NextResponse.json(
      { success: false, error: 'Webhook secret not configured' },
      { status: 503 },
    );
  }
  if (!signature || !verifyOutstandWebhookSignature(rawBody, signature, secret)) {
    console.warn('[Outstand webhook] invalid or missing signature');
    return NextResponse.json(
      { success: false, error: 'Invalid signature' },
      { status: 401 }
    );
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
  let claim: ProviderWebhookClaim;
  const eventId = await sha256(rawBody);
  try {
    claim = await claimProviderWebhookEvent(
      'outstand',
      eventId,
      parsed.event,
    );
  } catch (error) {
    console.error('[Outstand webhook] durable admission failed:', error);
    return NextResponse.json(
      { success: false, error: 'Webhook admission unavailable' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
  if (claim.state === 'completed') {
    return NextResponse.json({ success: true, duplicate: true });
  }
  if (claim.state === 'busy') {
    return NextResponse.json(
      { success: false, error: 'Webhook admission unavailable' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }

  try {
    await processOutstandWebhookPayload(parsed);
    const completed = await finishProviderWebhookEvent(
      'outstand',
      eventId,
      claim.token,
      'completed',
    );
    if (!completed) {
      throw new Error('Outstand webhook claim ownership was lost before completion');
    }
    return NextResponse.json({ success: true, received: true, event: parsed.event });
  } catch (err) {
    await finishProviderWebhookEvent(
      'outstand',
      eventId,
      claim.token,
      'failed',
      err instanceof Error ? err.message : String(err),
    ).catch((finishError) => {
      console.error('[Outstand webhook] failed to record processing failure:', finishError);
    });
    console.error('[Outstand webhook] processing error:', err);
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
