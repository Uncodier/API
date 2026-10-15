import { supabaseAdmin } from '@/lib/database/supabase-client';
import { calculateOpenRouterCreditCharge } from './agent-pricing';

export interface OpenRouterUsageCharge {
  siteId: string;
  usage: unknown;
  generationId?: string;
  /** Stable host-generated identity, created before dispatch; not supplied by the model. */
  eventId: string;
  metadata?: Record<string, unknown>;
}

export class OpenRouterBillingError extends Error {
  constructor() {
    super('OpenRouter credit deduction unconfirmed; billing requires reconciliation');
    this.name = 'OpenRouterBillingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One ledger event per accepted generation, even after a lost RPC response. */
export async function chargeOpenRouterUsage(input: OpenRouterUsageCharge): Promise<void> {
  if (!input.siteId || !input.eventId) throw new Error('Missing OpenRouter billing ownership');
  let cost: number | null = null;
  try { calculateOpenRouterCreditCharge(input.usage); cost = (input.usage as { cost: number }).cost; }
  catch { /* Persist accepted, unpriced work instead of estimating from token counts. */ }
  let result: { data: any; error: unknown };
  try { result = await supabaseAdmin.rpc('bill_openrouter_generation', {
    p_site_id: input.siteId,
    p_event_id: input.generationId || input.eventId,
    p_provider_cost: cost,
    // Deliberately do not persist arbitrary provider/model content or raw usage here.
    p_metadata: Object.fromEntries(Object.entries(input.metadata || {}).filter(([key, value]) =>
      ['command_id', 'agent_id', 'instance_id', 'session_id', 'plan_id', 'run_plan_id', 'step_id',
        'message_id', 'attempt', 'retry_count', 'model', 'context'].includes(key) &&
      ((typeof value === 'string' && value.length <= 256) ||
        (typeof value === 'number' && Number.isFinite(value)))),
    ),
  }); } catch { throw new OpenRouterBillingError(); }
  if (result.error || result.data?.success !== true || cost === null) {
    // An uncertain response may already have committed. Stop; never re-run inference.
    throw new OpenRouterBillingError();
  }
}