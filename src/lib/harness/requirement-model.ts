import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createHarnessModel } from './model';
import { calculateOpenRouterCreditCharge, OPENROUTER_COST_MULTIPLIER } from '@/lib/services/billing/agent-pricing';
import type { HarnessModel, ModelBillingEvidence } from './types';
import type { RequirementRun } from './requirement-types';

/** Retry ledger transport ONLY, always using the same durable event identity. */
async function ledger(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error } = await supabaseAdmin.rpc(name, args);
      if (!error && data) return data;
    } catch { /* A lost response is not proof that the transaction failed. */ }
  }
  throw new Error('billing_unavailable_or_exhausted: ledger response unavailable');
}

function reserveAndSettle(reserve: (eventId: string, amount: number) => Promise<Record<string, any>>,
  sessionId: string, assertActive: () => Promise<void>, model: HarnessModel): HarnessModel {
  return { async respond(input) {
    input.signal.throwIfAborted();
    await assertActive();
    const inputUpperBound = Buffer.byteLength(JSON.stringify({ system: input.system, messages: input.messages,
      tools: input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }));
    // Admission hold only. Final price always comes from usage.cost, not these token bounds.
    const amount = (inputUpperBound + input.maxOutputTokens * 20) / 1000000 * OPENROUTER_COST_MULTIPLIER;
    const eventId = crypto.randomUUID();
    const identity = { p_session_id: sessionId, p_event_id: eventId };
    const cancel = async (reason: 'predispatch' | 'admission_rejected') => {
      const result = await ledger('cancel_harness_model_reservation', { ...identity, p_reason: reason });
      if (result.success !== true) throw new Error('billing_unavailable_or_exhausted: reservation refund pending');
    };
    let reserved;
    try { reserved = await reserve(eventId, amount); }
    catch (error) {
      // Dispatch is impossible here. Recover a committed hold after a lost reserve response.
      await ledger('cancel_harness_model_reservation', { ...identity, p_reason: 'predispatch' }).catch(() => undefined);
      throw error;
    }
    if (reserved.success !== true || reserved.state !== 'reserved') throw new Error('billing_unavailable_or_exhausted');
    try {
      input.signal.throwIfAborted();
      await assertActive();
      const dispatched = await ledger('dispatch_harness_model_reservation', identity);
      if (dispatched.success !== true) throw new Error('billing_unavailable_or_exhausted');
      input.signal.throwIfAborted();
    } catch (error) {
      // No model invocation has started, even when the dispatch-marker response was lost.
      await cancel('predispatch');
      throw error;
    }
    const settle = async (evidence: ModelBillingEvidence) => {
      let cost: number | null = null;
      try { calculateOpenRouterCreditCharge(evidence.usage); cost = evidence.usage!.cost!; } catch { /* No token fallback. */ }
      const result = await ledger('settle_harness_model_reservation', { ...identity, p_cost: cost,
        p_generation_id: evidence.generationId ?? null, p_model: evidence.model ?? null });
      if (result.success !== true) throw new Error('billing_unavailable_or_exhausted: actual cost reconciliation pending');
    };
    let reply;
    try { reply = await model.respond(input); }
    catch (error) {
      const evidence = error as ModelBillingEvidence & { status?: number };
      if ((evidence?.admissionRejected === true || [401, 402, 403].includes(Number(evidence?.status)))
        && !evidence.usage && !evidence.generationId) {
        await cancel('admission_rejected');
        if ([401, 402, 403].includes(Number(evidence.status))) throw new Error('provider_admission_requires_operator');
      } else {
        // Accepted but malformed output is still paid work. Transport uncertainty stays held.
        await settle(evidence || {});
      }
      throw error;
    }
    // Deliberately no assertActive: ownership can be paused/lost AFTER paid inference.
    await settle(reply);
    return reply;
  } };
}

/** Requirement/review models and standalone harnesses share the same atomic hold ledger. */
export function createRequirementModel(run: RequirementRun, assertActive: () => Promise<void>, model = createHarnessModel()): HarnessModel {
  return reserveAndSettle((eventId, amount) => ledger('reserve_agent_requirement_credits', {
      p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
      p_session_id: run.sessionId, p_event_id: eventId, p_amount: amount,
    }), run.sessionId, assertActive, model);
}

export function createBilledHarnessModel(scope: { sessionId: string; siteId: string; owner: string },
  assertActive: () => Promise<void>, model = createHarnessModel()): HarnessModel {
  return reserveAndSettle((eventId, amount) => ledger('reserve_harness_model_credits', {
    p_session_id: scope.sessionId, p_site_id: scope.siteId, p_owner: scope.owner, p_event_id: eventId, p_amount: amount,
  }), scope.sessionId, assertActive, model);
}