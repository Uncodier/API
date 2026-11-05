import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { RequirementRun } from '@/lib/harness/requirement-types';
import { RequirementBudgetError } from './requirement-cycle-failure';
export { RequirementBudgetError } from './requirement-cycle-failure';

function budgetFailure(error: unknown): RequirementBudgetError {
  // P0001 alone is not specific: only the exact host SQL validation message is
  // configuration failure. Never expose arbitrary database/provider details.
  const receipt = error as { code?: unknown; message?: unknown } | null;
  return new RequirementBudgetError(receipt?.code === 'P0001' && receipt.message === 'Invalid requirement monetary budget'
    ? 'configuration_invalid' : 'evaluation_unavailable');
}

/** Once per cycle, before profile/workspace/model work. SQL owns the projection. */
export async function evaluateRequirementCycleBudget(run: RequirementRun): Promise<boolean> {
  let receipt;
  try {
    receipt = await supabaseAdmin.rpc('evaluate_requirement_cycle_budget', {
      p_requirement_id: run.requirementId, p_run_id: run.runId,
      p_generation: run.executionGeneration, p_session_id: run.sessionId,
    });
  } catch (error) {
    throw budgetFailure(error);
  }
  const { data, error } = receipt || {};
  if (error) throw budgetFailure(error);
  if (!data || !['unlimited', 'available', 'exhausted'].includes(data.state)) {
    throw new RequirementBudgetError('evaluation_unavailable');
  }
  return data.state === 'exhausted';
}