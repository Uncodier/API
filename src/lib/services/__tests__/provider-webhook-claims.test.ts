import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
} from '../provider-webhook-claims';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    rpc: jest.fn(),
  },
}));

describe('provider webhook claims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a fencing token for a claimed event', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: {
        state: 'claimed',
        claim_expires_at: '2026-09-20T08:00:00.000Z',
      },
      error: null,
    } as never);

    const claim = await claimProviderWebhookEvent(
      'stripe',
      'evt_123',
      'checkout.session.completed',
    );

    expect(claim).toEqual({
      state: 'claimed',
      token: expect.any(String),
      expiresAt: '2026-09-20T08:00:00.000Z',
    });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      'claim_provider_webhook_event',
      expect.objectContaining({
        p_provider: 'stripe',
        p_event_id: 'evt_123',
        p_claim_token: claim.state === 'claimed' ? claim.token : undefined,
      }),
    );
  });

  it.each(['busy', 'completed'] as const)(
    'returns the %s state without a token',
    async (state) => {
      (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
        data: { state },
        error: null,
      } as never);

      await expect(claimProviderWebhookEvent(
        'stripe',
        'evt_123',
        'payment_intent.succeeded',
      )).resolves.toEqual({ state });
    },
  );

  it('token-fences terminal updates', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: true,
      error: null,
    } as never);

    await expect(finishProviderWebhookEvent(
      'stripe',
      'evt_123',
      'claim-token',
      'completed',
    )).resolves.toBe(true);

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      'finish_provider_webhook_event',
      expect.objectContaining({
        p_claim_token: 'claim-token',
        p_status: 'completed',
      }),
    );
  });

  it('fails closed when the claim database is unavailable', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    } as never);

    await expect(claimProviderWebhookEvent(
      'stripe',
      'evt_123',
      'payment_intent.succeeded',
    )).rejects.toThrow(
      'Failed to claim provider webhook event: database unavailable',
    );
  });
});

describe('provider webhook claim migration', () => {
  const sql = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260920005000_add_provider_webhook_event_claims.sql',
  ), 'utf8');
  const repairSql = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260920007000_fix_provider_webhook_claims.sql',
  ), 'utf8');

  it('enables RLS and fences stale claims and completion', () => {
    expect(sql).toMatch(
      /ALTER TABLE private\.provider_webhook_events ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sql).toMatch(/claim_expires_at IS NULL/i);
    expect(sql).toMatch(/claim_expires_at <= timezone\('utc', now\(\)\)/i);
    expect(sql).toMatch(/AND claim_token = p_claim_token/i);
    expect(sql).toMatch(/attempt_count = attempt_count \+ 1/i);
    expect(sql).toMatch(
      /ON public\.payments \(transaction_id\);/i,
    );
    expect(sql).not.toMatch(
      /ON public\.payments \(transaction_id\)\s+WHERE/i,
    );
    expect(repairSql).toMatch(
      /DROP INDEX IF EXISTS public\.payments_transaction_id_uidx/i,
    );
    expect(repairSql).toContain('v_new_expires_at');
    expect(repairSql).toContain('v_claim_expires_at');
  });
});
