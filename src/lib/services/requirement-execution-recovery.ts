import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function resumeRequirementExecutionOnUserAction(
  requirementId: string,
  instanceId: string | null,
  reopenPausedPlans: boolean,
  actionId: string,
  allowTerminalReopen = false,
): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc(
    'resume_instance_execution_on_user_action',
    {
      p_requirement_id: requirementId,
      p_instance_id: instanceId,
      p_reopen_paused_plans: reopenPausedPlans,
      p_action_id: actionId,
      p_allow_terminal_reopen: allowTerminalReopen,
    },
  );
  if (error) {
    throw new Error(
      `Failed to resume instance execution after user action: ${error.message}`,
    );
  }
  if (
    !data ||
    typeof data.plans_updated !== 'number' ||
    typeof data.steps_cleared !== 'number'
  ) {
    throw new Error('Instance execution recovery RPC returned an invalid result');
  }
}
