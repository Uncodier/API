import { supabaseAdmin } from '@/lib/database/supabase-client';
import { calculateOpenRouterCreditCharge, OPENROUTER_COST_MULTIPLIER } from '@/lib/services/billing/agent-pricing';
import { OpenRouterBillingError, RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';
import type { RequirementRun } from '@/lib/harness/requirement-types';

/** Accounting adapter only. Inference remains exclusively in AIAgentExecutor. */
export function createRequirementAssistantBilling(run: RequirementRun, assertActive: () => Promise<void>) {
  const ledger = async (name: string, args: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await supabaseAdmin.rpc(name, args);
        if (!error && data?.success === true) return data;
        if (!error && name === 'reserve_agent_requirement_credits' &&
          data?.success === false && data.error === 'Insufficient credits') {
          throw new RequirementCreditsExhaustedError(args.p_amount as number);
        }
        if (!error && data) throw new OpenRouterBillingError();
      } catch (error) {
        if (error instanceof OpenRouterBillingError) throw error;
      }
    }
    throw new OpenRouterBillingError();
  };
  const identity = (eventId: string) => ({ p_session_id: run.sessionId, p_event_id: eventId });
  const cancel = (eventId: string, reason: 'predispatch' | 'admission_rejected') =>
    ledger('cancel_harness_model_reservation', { ...identity(eventId), p_reason: reason });
  const settle = async ({ eventId, usage, generationId, model }: {
    eventId: string; usage: unknown; generationId?: string; model?: string;
  }) => {
    let cost: number | null = null;
    try { calculateOpenRouterCreditCharge(usage); cost = (usage as { cost: number }).cost; } catch { /* Unknown cost stays held. */ }
    // No ownership assertion: paid inference must settle even after a user pause.
    await ledger('settle_harness_model_reservation', { ...identity(eventId), p_cost: cost,
      p_generation_id: generationId ?? null, p_model: model ?? null });
    if (cost === null) throw new OpenRouterBillingError();
  };
  return {
    async beforeDispatch({ eventId, inputBytes, maxOutputTokens }: { eventId: string; inputBytes: number; maxOutputTokens: number }) {
      await assertActive();
      if (!eventId || !Number.isSafeInteger(inputBytes) || inputBytes < 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
        throw new OpenRouterBillingError();
      }
      try {
        const reservation = await ledger('reserve_agent_requirement_credits', {
          p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
          ...identity(eventId), p_amount: (inputBytes + maxOutputTokens * 20) / 1000000 * OPENROUTER_COST_MULTIPLIER,
        });
        if (reservation.state !== 'reserved') throw new OpenRouterBillingError();
        await assertActive();
        await ledger('dispatch_harness_model_reservation', identity(eventId));
      } catch (error) {
        // The caller has not invoked the provider. Never rerun inference to recover a hold.
        await cancel(eventId, 'predispatch').catch(() => undefined);
        throw error;
      }
    },
    settle,
    async failed({ eventId, error, model }: { eventId: string; error: unknown; model?: string }) {
      const e = error as any;
      const usage = e?.usage || e?.error?.usage;
      const generationId = e?.generationId || e?.error?.generation_id || e?.error?.metadata?.generation_id;
      const rejected = [400, 401, 402, 403, 404, 405, 409, 422, 429, 503].includes(Number(e?.status)) && !usage && !generationId;
      if (rejected) { await cancel(eventId, 'admission_rejected'); return; }
      await settle({ eventId, usage, generationId, model: e?.model || model });
    },
  };
}