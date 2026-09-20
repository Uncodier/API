import { NextRequest, NextResponse } from 'next/server';
import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
  type ProviderWebhookClaim,
} from '@/lib/services/provider-webhook-claims';

export interface GearWebhookClaim {
  eventId: string;
  token: string;
}

type AuthenticationResult =
  | { ok: true; webhookData: any; claim: GearWebhookClaim }
  | { ok: false; response: NextResponse };

export async function authenticateGearWebhook(
  request: NextRequest,
): Promise<AuthenticationResult> {
  const contentType = request.headers.get('content-type') || '';
  let webhookData: any;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    webhookData = Object.fromEntries((await request.formData()).entries());
  } else if (contentType.includes('application/json')) {
    webhookData = await request.json();
  } else {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Unsupported content type' },
        { status: 400 },
      ),
    };
  }

  const signature = request.headers.get('x-twilio-signature');
  const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN;
  if (
    !signature
    || !authToken
    || !TwilioValidationService.validateSignature(
      request.url,
      webhookData,
      signature,
      authToken,
    )
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid signature' },
        { status: authToken ? 401 : 503 },
      ),
    };
  }
  if (!webhookData.From || !webhookData.To || !webhookData.MessageSid) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Missing required webhook data' },
        { status: 400 },
      ),
    };
  }

  let claim: ProviderWebhookClaim;
  try {
    claim = await claimProviderWebhookEvent(
      'twilio-whatsapp-gear',
      String(webhookData.MessageSid),
      'message.received',
    );
  } catch (error) {
    console.error('[Gear WhatsApp webhook] durable admission failed:', error);
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Webhook admission unavailable' },
        { status: 503, headers: { 'Retry-After': '5' } },
      ),
    };
  }
  if (claim.state === 'completed') {
    return {
      ok: false,
      response: NextResponse.json(
        { success: true, duplicate: true },
        { status: 200 },
      ),
    };
  }
  if (claim.state === 'busy') {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Webhook admission unavailable' },
        { status: 503, headers: { 'Retry-After': '5' } },
      ),
    };
  }
  return {
    ok: true,
    webhookData,
    claim: {
      eventId: String(webhookData.MessageSid),
      token: claim.token,
    },
  };
}

export async function finishGearWebhookClaim(
  claim: GearWebhookClaim,
  status: 'completed' | 'failed',
  errorMessage?: string,
): Promise<void> {
  const finished = await finishProviderWebhookEvent(
    'twilio-whatsapp-gear',
    claim.eventId,
    claim.token,
    status,
    errorMessage,
  );
  if (!finished) {
    throw new Error('Gear WhatsApp webhook claim ownership was lost');
  }
}
