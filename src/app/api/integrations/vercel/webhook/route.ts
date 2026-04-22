import { NextRequest, NextResponse } from 'next/server';
import { verifyVercelWebhookSignature } from '@/lib/integrations/vercel/webhook-verification';
import { isVercelWebhookEvent } from '@/lib/integrations/vercel/webhook-types';
import { handleVercelWebhookEvent } from '@/lib/integrations/vercel/process-webhook';

export const runtime = 'nodejs';

/**
 * POST https://backend.makinari.com/api/integrations/vercel/webhook
 *
 * Signed by Vercel with HMAC-SHA1 over the raw body (header `x-vercel-signature`).
 * Set `VERCEL_WEBHOOK_SECRET` to the same value configured in the Vercel dashboard.
 *
 * Events we care about: `deployment.created`, `deployment.building`,
 * `deployment.ready`, `deployment.succeeded`, `deployment.error`,
 * `deployment.canceled`, `deployment.promoted`. Everything else is acked 200.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Vercel webhook] VERCEL_WEBHOOK_SECRET is not set — refusing to process');
    return NextResponse.json(
      { success: false, error: 'Webhook secret not configured' },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-vercel-signature');

  if (!verifyVercelWebhookSignature(rawBody, signature, secret)) {
    console.warn('[Vercel webhook] invalid or missing signature');
    return NextResponse.json(
      { success: false, error: 'Invalid signature' },
      { status: 401 },
    );
  }

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON' },
      { status: 400 },
    );
  }

  if (!isVercelWebhookEvent(parsed)) {
    return NextResponse.json(
      { success: false, error: 'Invalid webhook payload' },
      { status: 400 },
    );
  }

  try {
    const outcome = await handleVercelWebhookEvent(parsed);
    return NextResponse.json({ success: true, ...outcome }, { status: 202 });
  } catch (err) {
    console.error('[Vercel webhook] processing error:', err);
    // We intentionally still 200-ack here rather than 500 so Vercel does not
    // replay the event on our logs. Failures are logged server-side; the next
    // cron tick + GitHub Deployments poll will keep the product loop honest.
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 200 },
    );
  }
}
