import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { POST } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
} from '@/lib/services/provider-webhook-claims';

const mockConstructEvent = jest.fn();

jest.mock('stripe', () => jest.fn(() => ({
  webhooks: {
    constructEvent: (...args: unknown[]) => mockConstructEvent(...args),
  },
})));
jest.mock('next/headers', () => ({
  headers: jest.fn(),
}));
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));
jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));
jest.mock('@/lib/status/telemetry', () => ({
  recordTelemetry: jest.fn(() => Promise.resolve()),
}));

describe('Stripe webhook durable processing', () => {
  const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const paymentUpsert = jest.fn();

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  afterAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (headers as jest.Mock).mockResolvedValue(new Headers({
      'stripe-signature': 'valid-signature',
    }));
    (claimProviderWebhookEvent as jest.Mock).mockResolvedValue({
      state: 'claimed',
      token: 'claim-token',
      expiresAt: '2026-09-20T08:05:00.000Z',
    });
    (finishProviderWebhookEvent as jest.Mock).mockResolvedValue(true);
    paymentUpsert.mockResolvedValue({ error: null });
  });

  function request() {
    return new NextRequest(
      'http://localhost/api/integrations/stripe/webhook',
      { method: 'POST', body: '{}' },
    );
  }

  it('uses the database conflict target and completes after payment insertion', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          metadata: { site_id: 'site-123' },
          amount_total: 1000,
          currency: 'usd',
          created: 1,
        },
      },
    });
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'payments') return { upsert: paymentUpsert };
      throw new Error(`Unexpected table: ${table}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(paymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_id: 'cs_123' }),
      { onConflict: 'transaction_id', ignoreDuplicates: true },
    );
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'stripe',
      'evt_checkout',
      'claim-token',
      'completed',
    );
  });

  it('marks the claim failed when campaign metadata cannot be loaded', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_campaign',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_campaign',
          metadata: {
            site_id: 'site-123',
            campaign_id: 'campaign-123',
            type: 'campaign_outsourcing',
          },
          amount_total: 1000,
          currency: 'usd',
          created: 1,
        },
      },
    });
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'payments') return { upsert: paymentUpsert };
      if (table === 'campaigns') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn().mockResolvedValue({
                data: null,
                error: new Error('database unavailable'),
              }),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'stripe',
      'evt_campaign',
      'claim-token',
      'failed',
      'database unavailable',
    );
    expect(finishProviderWebhookEvent).not.toHaveBeenCalledWith(
      'stripe',
      'evt_campaign',
      'claim-token',
      'completed',
    );
  });

  it('does not complete a payment event with missing site metadata', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_missing_site',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_123',
          metadata: { created_from: 'outsource_checkout' },
          amount: 1000,
          currency: 'usd',
          created: 1,
        },
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(paymentUpsert).not.toHaveBeenCalled();
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith(
      'stripe',
      'evt_missing_site',
      'claim-token',
      'failed',
      'Missing site_id in Stripe payment intent metadata',
    );
  });
});
