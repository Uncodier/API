import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function claimWorkflowRunExecution(runPlanId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('workflow_runs')
    .update({
      status: 'in_progress',
      updated_at: new Date().toISOString(),
    })
    .eq('run_plan_id', runPlanId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to claim workflow run: ${error.message}`);
  }

  return Boolean(data);
}
