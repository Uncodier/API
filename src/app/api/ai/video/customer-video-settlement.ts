import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CustomerReceiptError } from '@/lib/services/billing/customer-inference-receipts';
import type { CustomerVideoJob } from './customer-video-jobs';

/** Freeze the actual RPC payload before delivery, not merely inputs to a future serializer. */
export function videoSettlement(job: CustomerVideoJob, status: 'completed' | 'failed') {
  if (job.routing.payer !== 'customer') throw new CustomerReceiptError();
  return { status, receipt: {
    site_id: job.siteId, connection_id: job.routing.connectionId,
    policy_version: job.routing.policyVersion, credential_version: job.routing.credentialVersion,
    event_id: job.eventId, generation_id: job.generationId ?? null, model: null,
    capability: 'video', usage_evidence: {
      gateway_account_cost: job.cost ?? null, requested_model: job.request.model,
      actual_model: null, provider: null, prompt_tokens: null, completion_tokens: null, total_tokens: null,
    }, state: status === 'failed' || job.cost === undefined ? 'uncertain' : 'completed',
  } };
}

export async function deliverVideoSettlement(job: CustomerVideoJob) {
  if (!job.settlement) throw new CustomerReceiptError();
  try {
    const { error } = await supabaseAdmin.rpc('openrouter_customer_receipt', { p_receipt: job.settlement.receipt });
    if (error) throw new CustomerReceiptError();
  } catch { throw new CustomerReceiptError(); }
}