import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { RequirementRun } from '@/lib/harness/requirement-types';

/** Once per cycle, before profile/workspace/model work. SQL owns the projection. */
export async function evaluateRequirementCycleBudget(run: RequirementRun): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('evaluate_requirement_cycle_budget', {
    p_requirement_id: run.requirementId, p_run_id: run.runId,
    p_generation: run.executionGeneration, p_session_id: run.sessionId,
  });
  if (error || !data || !['unlimited', 'available', 'exhausted'].includes(data.state)) {
    throw new Error('Requirement monetary budget evaluation unavailable');
  }
  return data.state === 'exhausted';
}