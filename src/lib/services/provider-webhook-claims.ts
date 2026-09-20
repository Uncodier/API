import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export type ProviderWebhookClaim =
  | { state: 'claimed'; token: string; expiresAt: string }
  | { state: 'busy' }
  | { state: 'completed' };

interface ClaimRpcResult {
  state?: unknown;
  claim_expires_at?: unknown;
}

export async function claimProviderWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  leaseSeconds = 300,
): Promise<ProviderWebhookClaim> {
  const token = randomUUID();
  const { data, error } = await supabaseAdmin.rpc(
    'claim_provider_webhook_event',
    {
      p_provider: provider,
      p_event_id: eventId,
      p_event_type: eventType,
      p_claim_token: token,
      p_lease_seconds: leaseSeconds,
    },
  );
  if (error) {
    throw new Error(`Failed to claim provider webhook event: ${error.message}`);
  }

  const result = data as ClaimRpcResult | null;
  if (result?.state === 'completed') return { state: 'completed' };
  if (result?.state === 'busy') return { state: 'busy' };
  if (
    result?.state !== 'claimed'
    || typeof result.claim_expires_at !== 'string'
  ) {
    throw new Error('Provider webhook claim RPC returned an invalid result');
  }
  return {
    state: 'claimed',
    token,
    expiresAt: result.claim_expires_at,
  };
}

export async function finishProviderWebhookEvent(
  provider: string,
  eventId: string,
  token: string,
  status: 'completed' | 'failed',
  errorMessage?: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc(
    'finish_provider_webhook_event',
    {
      p_provider: provider,
      p_event_id: eventId,
      p_claim_token: token,
      p_status: status,
      p_error_message: errorMessage || null,
    },
  );
  if (error) {
    throw new Error(`Failed to finish provider webhook event: ${error.message}`);
  }
  return data === true;
}
