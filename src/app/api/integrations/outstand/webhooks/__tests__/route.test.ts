import { NextRequest } from 'next/server';
import { POST } from '../route';
import { processOutstandWebhookPayload } from '@/lib/integrations/outstand/process-webhook';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
} from '@/lib/services/provider-webhook-claims';

jest.mock('@/lib/integrations/outstand/webhook-verification', () => ({
  verifyOutstandWebhookSignature: jest.fn(() => true),
}));
jest.mock('@/lib/integrations/outstand/process-webhook', () => ({
  processOutstandWebhookPayload: jest.fn(),
}));
jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));

describe('Outstand webhook durable processing', () => {
  const originalSecret = process.env.OUTSTAND_WEBHOOK_SECRET;
  const payload = {
    event: 'test',
    timestamp: '2026-09-20T08:00:00.000Z',
    data: { message: 'test', endpointId: 1 },
  };

  beforeAll(() => {
    process.env.OUTSTAND_WEBHOOK_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.OUTSTAND_WEBHOOK_SECRET = originalSecret;
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
    return new NextRequest(
      'http://localhost/api/integrations/outstand/webhooks',
      {
        method: 'POST',
        headers: { 'x-outstand-signature': 'valid' },
        body: JSON.stringify(payload),
      },
    );
  }

  it('completes the durable claim after processing succeeds', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(processOutstandWebhookPayload).toHaveBeenCalledWith(payload);
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'outstand',
      expect.any(String),
      'claim-token',
      'completed',
    );
  });

  it('marks processing failures retryable', async () => {
    (processOutstandWebhookPayload as jest.Mock)
      .mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'outstand',
      expect.any(String),
      'claim-token',
      'failed',
      'database unavailable',
    );
  });
});
