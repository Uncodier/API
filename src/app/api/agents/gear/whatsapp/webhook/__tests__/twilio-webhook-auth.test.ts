import { NextRequest } from 'next/server';
import {
  authenticateGearWebhook,
  finishGearWebhookClaim,
} from '../twilio-webhook-auth';
import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
} from '@/lib/services/provider-webhook-claims';

jest.mock('@/lib/services/twilio/TwilioValidationService', () => ({
  TwilioValidationService: {
    validateSignature: jest.fn(),
  },
}));
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
    (TwilioValidationService.validateSignature as jest.Mock)
      .mockReturnValue(true);
    (claimProviderWebhookEvent as jest.Mock).mockResolvedValue({
      state: 'claimed',
      token: 'claim-token',
      expiresAt: '2026-09-20T08:05:00.000Z',
    });
    (finishProviderWebhookEvent as jest.Mock).mockResolvedValue(true);
  });

  function request() {
    return new NextRequest(
      'http://localhost/api/agents/gear/whatsapp/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-twilio-signature': 'valid-signature',
        },
        body: JSON.stringify({
          From: 'whatsapp:+15551234567',
          To: 'whatsapp:+15557654321',
          MessageSid: 'SM123',
        }),
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
