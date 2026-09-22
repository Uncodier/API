import crypto from 'crypto';
import { NextRequest } from 'next/server';
import {
  authenticateGearWebhook,
  finishGearWebhookClaim,
} from '../twilio-webhook-auth';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
} from '@/lib/services/provider-webhook-claims';

jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));

describe('Gear Twilio webhook durable admission', () => {
  const originalToken = process.env.GEAR_TWILIO_AUTH_TOKEN;

  beforeAll(() => {
    process.env.GEAR_TWILIO_AUTH_TOKEN = 'test-token';
  });

  afterAll(() => {
    process.env.GEAR_TWILIO_AUTH_TOKEN = originalToken;
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
    const url = 'https://backend.makinari.com/api/agents/gear/whatsapp/webhook';
    const webhookData = {
      From: 'whatsapp:+15551234567',
      To: 'whatsapp:+15557654321',
      MessageSid: 'SM123',
    };
    const signedPayload = Object.keys(webhookData)
      .sort()
      .reduce(
        (value, key) => value + key + webhookData[key as keyof typeof webhookData],
        url,
      );
    const signature = crypto
      .createHmac('sha1', 'test-token')
      .update(signedPayload)
      .digest('base64');

    return new NextRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature,
        },
        body: new URLSearchParams(webhookData).toString(),
      },
    );
  }

  it('returns a durable claim after signature validation', async () => {
    const result = await authenticateGearWebhook(request());

    expect(result).toEqual({
      ok: true,
      webhookData: expect.objectContaining({ MessageSid: 'SM123' }),
      claim: { eventId: 'SM123', token: 'claim-token' },
    });
    expect(claimProviderWebhookEvent).toHaveBeenCalledWith(
      'twilio-whatsapp-gear',
      'SM123',
      'message.received',
    );
  });

  it('validates JSON webhooks against bodySHA256 and the raw body', async () => {
    const rawBody = JSON.stringify({
      From: 'whatsapp:+15551234567',
      To: 'whatsapp:+15557654321',
      MessageSid: 'SM456',
    });
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const url = `https://backend.makinari.com/api/agents/gear/whatsapp/webhook?bodySHA256=${bodyHash}`;
    const signature = crypto
      .createHmac('sha1', 'test-token')
      .update(url)
      .digest('base64');
    const jsonRequest = new NextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-twilio-signature': signature,
      },
      body: rawBody,
    });

    const result = await authenticateGearWebhook(jsonRequest);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected webhook authentication to pass');
    expect(result.webhookData.MessageSid).toBe('SM456');
  });

  it('preserves repeated form values during signature validation', async () => {
    const url = 'https://backend.makinari.com/api/agents/gear/whatsapp/webhook';
    const body = new URLSearchParams();
    body.append('From', 'whatsapp:+15551234567');
    body.append('MessageSid', 'SM457');
    body.append('Tag', 'beta');
    body.append('Tag', 'alpha');
    body.append('Tag', 'alpha');
    body.append('To', 'whatsapp:+15557654321');
    const signedPayload = url
      + 'Fromwhatsapp:+15551234567'
      + 'MessageSidSM457'
      + 'TagalphaTagbeta'
      + 'Towhatsapp:+15557654321';
    const signature = crypto
      .createHmac('sha1', 'test-token')
      .update(signedPayload)
      .digest('base64');

    const result = await authenticateGearWebhook(new NextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      body: body.toString(),
    }));

    expect(result.ok).toBe(true);
  });

  it('rejects JSON when bodySHA256 does not match the raw body', async () => {
    const rawBody = JSON.stringify({
      From: 'whatsapp:+15551234567',
      To: 'whatsapp:+15557654321',
      MessageSid: 'SM789',
    });
    const url = `https://backend.makinari.com/api/agents/gear/whatsapp/webhook?bodySHA256=${'0'.repeat(64)}`;
    const signature = crypto
      .createHmac('sha1', 'test-token')
      .update(url)
      .digest('base64');

    const result = await authenticateGearWebhook(new NextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-twilio-signature': signature,
      },
      body: rawBody,
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected webhook authentication to fail');
    expect(result.response.status).toBe(401);
    expect(claimProviderWebhookEvent).not.toHaveBeenCalled();
  });

  it('requests a retry while another worker owns the claim', async () => {
    (claimProviderWebhookEvent as jest.Mock)
      .mockResolvedValueOnce({ state: 'busy' });

    const result = await authenticateGearWebhook(request());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected webhook admission to fail');
    expect(result.response.status).toBe(503);
  });

  it('token-fences claim completion', async () => {
    await expect(finishGearWebhookClaim(
      { eventId: 'SM123', token: 'claim-token' },
      'completed',
    )).resolves.toBeUndefined();
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'twilio-whatsapp-gear',
      'SM123',
      'claim-token',
      'completed',
      undefined,
    );
  });

  it('fails when claim ownership was lost', async () => {
    (finishProviderWebhookEvent as jest.Mock).mockResolvedValueOnce(false);

    await expect(finishGearWebhookClaim(
      { eventId: 'SM123', token: 'stale-token' },
      'completed',
    )).rejects.toThrow('claim ownership was lost');
  });
});
