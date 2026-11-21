import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { InboundClaimIdentity } from './zavu/inbound-claim';

export type ProviderWebhookClaim =
  | { state: 'claimed'; token: string; expiresAt: string; reconcileOnly?: boolean }
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

export async function claimZavuInboundWebhook(identity: InboundClaimIdentity): Promise<ProviderWebhookClaim | { state: 'reconcile' }> {
  const token = randomUUID();
  const { data, error } = await supabaseAdmin.rpc('claim_zavu_inbound_webhook', {
    p_event_id: identity.eventId, p_fallback_message_id: identity.fallbackMessageId,
    p_binding_hash: identity.bindingHash, p_claim_token: token,
  });
  // Missing RPC, transport timeout or invalid retry disposition must never
  // downgrade to the generic RPC or permit a second workflow start.
  if (error) throw new Error('Unable to claim bound Zavu inbound receipt');
  const result = data as (ClaimRpcResult & { reconcile_only?: unknown }) | null;
  if (result?.state === 'busy' || result?.state === 'completed' || result?.state === 'reconcile') return { state: result.state };
  if (result?.state !== 'claimed' || typeof result.claim_expires_at !== 'string' || typeof result.reconcile_only !== 'boolean') {
    throw new Error('Invalid bound Zavu inbound claim result');
  }
  return { state: 'claimed', token, expiresAt: result.claim_expires_at, reconcileOnly: result.reconcile_only };
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
