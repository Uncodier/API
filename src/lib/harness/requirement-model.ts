import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createHarnessModel } from './model';
import type { HarnessModel } from './types';
import type { RequirementRun } from './requirement-types';

/** Reserve paid model work BEFORE dispatch using the existing site credit ledger. */
export function createRequirementModel(run: RequirementRun, assertActive: () => Promise<void>, model = createHarnessModel()): HarnessModel {
  return { async respond(input) {
    await assertActive();
    const inputUpperBound = Buffer.byteLength(JSON.stringify({ system: input.system, messages: input.messages,
      tools: input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }));
    const amount = (inputUpperBound + input.maxOutputTokens * 20) / 1000000;
    const eventId = crypto.randomUUID();
    const { data, error } = await supabaseAdmin.rpc('reserve_agent_requirement_credits', {
      p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
      p_session_id: run.sessionId, p_event_id: eventId, p_amount: amount,
    });
    if (error || data?.success !== true) throw new Error('billing_unavailable_or_exhausted');
    await assertActive();
    try { return await model.respond(input); }
    catch (error) {
      if ([401, 402, 403].includes(Number((error as { status?: number })?.status))) {
        throw new Error('provider_admission_requires_operator');
      }
      throw error;
    }
  } };
}