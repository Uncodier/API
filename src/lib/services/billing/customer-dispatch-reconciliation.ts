import { CustomerReceiptError } from './customer-inference-receipts';

/** Operator-only service API. Callers must authorize an operator; never expose to customer tools. */
export async function listUnresolvedCustomerDispatches(limit = 100) {
  const { supabaseAdmin } = await import('@/lib/database/supabase-client');
  const { data, error } = await supabaseAdmin.rpc('openrouter_customer_dispatch_pending', {
    p_limit: Math.min(500, Math.max(1, Math.trunc(limit))),
  });
  if (error || !Array.isArray(data)) throw new CustomerReceiptError();
  return data;
}

/** Evidence is obtained out-of-band. This never calls a provider or schedules inference. */
export async function reconcileCustomerDispatch(input: {
  eventId: string; authorizedOperatorId: string; resolution: 'completed' | 'uncertain' | 'rejected';
  reason: string; generationId?: string; gatewayAccountCost?: number;
}): Promise<void> {
  if (!input.authorizedOperatorId || !input.eventId || !input.reason.trim() || input.reason.length > 1000 ||
    (input.resolution === 'completed' && (!input.generationId || input.gatewayAccountCost === undefined)) ||
    (input.gatewayAccountCost !== undefined && (!Number.isFinite(input.gatewayAccountCost) || input.gatewayAccountCost < 0))) {
    throw new CustomerReceiptError();
  }
  const { supabaseAdmin } = await import('@/lib/database/supabase-client');
  const { error } = await supabaseAdmin.rpc('openrouter_customer_dispatch_reconcile', {
    p_event_id: input.eventId, p_actor_id: input.authorizedOperatorId, p_resolution: input.resolution,
    p_evidence: { reason: input.reason, generation_id: input.generationId,
      gateway_account_cost: input.gatewayAccountCost },
  });
  if (error) throw new CustomerReceiptError();
}