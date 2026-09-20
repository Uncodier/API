import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { recordTelemetry } from '@/lib/status/telemetry';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
  type ProviderWebhookClaim,
} from '@/lib/services/provider-webhook-claims';

type MessageProcessor = (
  message: any,
  phoneNumber: string,
  businessAccountId: string,
  siteId?: string,
  agentId?: string,
) => Promise<{ success: boolean } | null>;

function hasValidMetaSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signature || !signature.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function handleMetaWebhookPost(
  request: NextRequest,
  processMessage: MessageProcessor,
) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');
    if (!process.env.WHATSAPP_APP_SECRET) {
      console.error('[WhatsApp webhook] WHATSAPP_APP_SECRET is not configured');
      return NextResponse.json(
        { success: false, error: 'Webhook secret not configured' },
        { status: 503 },
      );
    }
    if (!hasValidMetaSignature(rawBody, signature)) {
      console.warn('[WhatsApp webhook] Invalid or missing signature');
      return NextResponse.json(
        { success: false, error: 'Invalid signature' },
        { status: 401 },
      );
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON' },
        { status: 400 },
      );
    }
    const siteId = request.nextUrl.searchParams.get('site_id');
    const agentId = request.nextUrl.searchParams.get('agent_id');
    if (
      !siteId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(siteId)
    ) {
      return NextResponse.json(
        { success: false, error: 'Invalid site_id parameter' },
        { status: 400 },
      );
    }
    if (!body?.object || !Array.isArray(body.entry)) {
      return NextResponse.json(
        { success: false, error: 'Invalid webhook format' },
        { status: 400 },
      );
    }

    for (const entry of body.entry) {
      if (!Array.isArray(entry?.changes)) continue;
      for (const change of entry.changes) {
        if (change?.field !== 'messages') continue;
        const businessAccountId =
          change.value?.metadata?.phone_number_id || 'unknown';
        if (!Array.isArray(change.value?.messages)) continue;
        for (const message of change.value.messages) {
          if (!message?.from || !message?.type || typeof message.id !== 'string') {
            continue;
          }
          let claim: ProviderWebhookClaim;
          try {
            claim = await claimProviderWebhookEvent(
              'meta-whatsapp',
              message.id,
              `message.${message.type}`,
            );
          } catch (error) {
            console.error('[WhatsApp webhook] durable admission failed:', error);
            return NextResponse.json(
              { success: false, error: 'Webhook admission unavailable' },
              { status: 503, headers: { 'Retry-After': '5' } },
            );
          }
          if (claim.state === 'completed') continue;
          if (claim.state === 'busy') {
            return NextResponse.json(
              { success: false, error: 'Webhook event is already processing' },
              { status: 503, headers: { 'Retry-After': '5' } },
            );
          }
          try {
            const result = await processMessage(
              message,
              message.from,
              businessAccountId,
              siteId,
              agentId || undefined,
            );
            if (!result?.success) {
              throw new Error('WhatsApp message processing did not complete');
            }
            const completed = await finishProviderWebhookEvent(
              'meta-whatsapp',
              message.id,
              claim.token,
              'completed',
            );
            if (!completed) {
              throw new Error(
                'WhatsApp webhook claim ownership was lost before completion',
              );
            }
          } catch (error) {
            await finishProviderWebhookEvent(
              'meta-whatsapp',
              message.id,
              claim.token,
              'failed',
              error instanceof Error ? error.message : String(error),
            ).catch((finishError) => {
              console.error(
                '[WhatsApp webhook] failed to record processing failure:',
                finishError,
              );
            });
            throw error;
          }
        }
      }
    }

    recordTelemetry('integrations', 'up', 'Processed WhatsApp Webhook')
      .catch(console.error);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[WhatsApp webhook] Processing failed:', error);
    recordTelemetry('integrations', 'down', 'WhatsApp Webhook error')
      .catch(console.error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
