import { randomUUID } from 'node:crypto';
import { openRouterCostEvidence } from './openrouter-cost-evidence';
import { getExecutionRouting, getCustomerOperationKey, CustomerRoutingError, type CustomerCapability,
  type ExecutionRoutingReference } from '../ai/customer-routing';

// In-memory proof only. Durable receipts are authoritative, never provider is_byok flags.
const completed = new WeakMap<ExecutionRoutingReference, Set<string>>();
const usages = new WeakMap<object, ExecutionRoutingReference>();

export class CustomerReceiptError extends Error {
  constructor() {
    super('Customer inference outcome requires reconciliation; do not replay');
    // Existing executor boundaries treat this name as terminal, not retryable inference.
    this.name = 'OpenRouterBillingError';
  }
}

/** Persist intent before touching the provider. Lost responses require reconciliation, not retry. */
export async function beginCustomerInference(input: {
  routing: ExecutionRoutingReference; capability: CustomerCapability; eventId?: string;
  operationKey?: string; requestedModel: string;
}): Promise<string> {
  const { routing } = input;
  if (routing.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_RECEIPT_OWNERSHIP');
  const eventId = input.eventId ?? randomUUID();
  const operationKey = input.operationKey ?? getCustomerOperationKey() ?? eventId;
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data, error } = await supabaseAdmin.rpc('openrouter_customer_dispatch', { p_intent: {
      site_id: routing.siteId, connection_id: routing.connectionId,
      policy_version: routing.policyVersion, credential_version: routing.credentialVersion,
      event_id: eventId, operation_key: operationKey, capability: input.capability,
      requested_model: input.requestedModel,
    } });
    if (error || data?.claimed !== true || data?.event_id !== eventId) throw new CustomerReceiptError();
    return eventId;
  } catch { throw new CustomerReceiptError(); }
}

/** Confirmed provider rejection closes the intent without fabricating cost evidence. */
export async function rejectCustomerInference(eventId: string, routing: ExecutionRoutingReference): Promise<void> {
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { error } = await supabaseAdmin.rpc('openrouter_customer_dispatch_reject', {
      p_site_id: routing.siteId, p_event_id: eventId,
    });
    if (error) throw new CustomerReceiptError();
  } catch { throw new CustomerReceiptError(); }
}

export async function recordCustomerInference(input: {
  routing: ExecutionRoutingReference; capability: CustomerCapability; eventId?: string;
  generationId?: string; model?: string; requestedModel?: string; provider?: string;
  usage?: unknown; uncertain?: boolean;
}): Promise<void> {
  const { routing } = input;
  if (routing.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_RECEIPT_OWNERSHIP');
  const evidence = openRouterCostEvidence(input.usage);
  const usage = input.usage && typeof input.usage === 'object' ? input.usage as Record<string, unknown> : {};
  const tokens = (field: string) => Number.isSafeInteger(usage[field]) && (usage[field] as number) >= 0 ? usage[field] : null;
  const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 256) : null;
  const receipt = {
    site_id: routing.siteId, connection_id: routing.connectionId,
    policy_version: routing.policyVersion, credential_version: routing.credentialVersion,
    event_id: input.eventId ?? randomUUID(),
    generation_id: typeof input.generationId === 'string' ? input.generationId.slice(0, 256) : null,
    model: typeof input.model === 'string' ? input.model.slice(0, 256) : null,
    capability: input.capability, usage_evidence: { ...evidence,
      gateway_account_cost: evidence.gateway_account_cost ?? null,
      requested_model: label(input.requestedModel),
      actual_model: label(input.model), provider: label(input.provider),
      prompt_tokens: tokens('prompt_tokens'), completion_tokens: tokens('completion_tokens'), total_tokens: tokens('total_tokens'),
    },
    state: input.uncertain || evidence.gateway_account_cost === undefined ? 'uncertain' : 'completed',
  };
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const result = await supabaseAdmin.rpc('openrouter_customer_receipt', { p_receipt: receipt });
    if (result.error) throw new CustomerReceiptError();
  } catch { throw new CustomerReceiptError(); }
  if (input.generationId) {
    const ids = completed.get(routing) ?? new Set<string>();
    ids.add(input.generationId);
    completed.set(routing, ids);
  }
  if (input.usage && typeof input.usage === 'object') usages.set(input.usage, routing);
}

/** A caller cannot waive billing merely by claiming a customer payer or zero cost. */
export function hasCustomerInferenceReceipt(siteId: string, usage: unknown, generationId?: string): boolean {
  const routing = getExecutionRouting(siteId);
  if (routing?.payer !== 'customer') return false;
  if ((generationId && completed.get(routing)?.has(generationId)) ||
      (usage && typeof usage === 'object' && usages.get(usage) === routing)) return true;
  throw new CustomerReceiptError();
}