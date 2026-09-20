import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { handleMetaWebhookPost } from '../post-handler';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
} from '@/lib/services/provider-webhook-claims';

jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));
jest.mock('@/lib/status/telemetry', () => ({
  recordTelemetry: jest.fn(() => Promise.resolve()),
}));

describe('Meta WhatsApp webhook durable processing', () => {
  const originalSecret = process.env.WHATSAPP_APP_SECRET;
  const secret = 'test-secret';
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'phone-number-id' },
          messages: [{
            id: 'wamid.123',
            from: '15551234567',
            type: 'text',
            text: { body: 'hello' },
          }],
        },
      }],
    }],
  });

  beforeAll(() => {
    process.env.WHATSAPP_APP_SECRET = secret;
  });

  afterAll(() => {
    process.env.WHATSAPP_APP_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (claimProviderWebhookEvent as jest.Mock).mockResolvedValue({
      state: 'claimed',
      token: 'claim-token',
      expiresAt: '2026-09-20T08:05:00.000Z',
    });
    (finishProviderWebhookEvent as jest.Mock).mockResolvedValue(true);
  });

  function request() {
    const signature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')}`;
    return new NextRequest(
      'http://localhost/api/integrations/whatsapp/webhook'
        + '?site_id=0dfe1ef0-b22a-4f16-80bd-b31c39fd7378',
      {
        method: 'POST',
        headers: { 'x-hub-signature-256': signature },
        body,
      },
    );
  }

  it('completes the claim only after message processing succeeds', async () => {
    const processMessage = jest.fn().mockResolvedValue({
      success: true,
      messageId: 'message-id',
      conversationId: 'conversation-id',
    });

    const response = await handleMetaWebhookPost(request(), processMessage);

    expect(response.status).toBe(200);
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'meta-whatsapp',
      'wamid.123',
      'claim-token',
      'completed',
    );
  });

  it('fails and releases the durable claim when processing is incomplete', async () => {
    const processMessage = jest.fn().mockResolvedValue(null);

    const response = await handleMetaWebhookPost(request(), processMessage);

    expect(response.status).toBe(500);
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'meta-whatsapp',
      'wamid.123',
      'claim-token',
      'failed',
      'WhatsApp message processing did not complete',
    );
  });
});
