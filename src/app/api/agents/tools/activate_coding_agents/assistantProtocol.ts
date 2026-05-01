import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface ActivateCodingAgentsParams {
  requirement_id: string;
}

export function activateCodingAgentsTool() {
  return {
    name: 'activate_coding_agents',
    description:
      'Finds all remote instances and instance plans associated with a given requirement_id and sets their status to running/in_progress. Use this tool when the user asks to resume, continue, or make changes to a requirement that might be paused.',
    parameters: {
      type: 'object',
      properties: {
        requirement_id: { type: 'string', description: 'The UUID of the requirement to activate.' },
      },
      required: ['requirement_id'],
    },
    execute: async (args: ActivateCodingAgentsParams) => {
      const { requirement_id } = args;
      if (!requirement_id) {
        throw new Error('Missing required field: requirement_id');
      }

      console.log(`[ActivateCodingAgentsTool] Activating agents for requirement: ${requirement_id}`);

      // Find remote instances by name convention
      const runnerName = `req-runner-${requirement_id}`;
      const maintName = `req-maint-${requirement_id}`;

      // Update remote_instances
      const { data: updatedInstances, error: instancesError } = await supabaseAdmin
        .from('remote_instances')
        .update({ status: 'running' })
        .in('name', [runnerName, maintName])
        .select('id, name, status');

      if (instancesError) {
        console.error('[ActivateCodingAgentsTool] Error updating remote_instances:', instancesError);
        throw new Error(`Failed to update remote_instances: ${instancesError.message}`);
      }

      const instanceIds = updatedInstances?.map(i => i.id) || [];

      let updatedPlans: any[] = [];
      if (instanceIds.length > 0) {
        // Update instance_plans
        const { data: plans, error: plansError } = await supabaseAdmin
          .from('instance_plans')
          .update({ status: 'in_progress' })
          .in('instance_id', instanceIds)
          .eq('status', 'paused')
          .select('id, status, instance_id');

        if (plansError) {
          console.error('[ActivateCodingAgentsTool] Error updating instance_plans:', plansError);
          throw new Error(`Failed to update instance_plans: ${plansError.message}`);
        }
        updatedPlans = plans || [];
      }

      // Unblock requirement if it was blocked
      const { data: req, error: reqError } = await supabaseAdmin
        .from('requirements')
        .select('status')
        .eq('id', requirement_id)
        .single();

      let requirementUnblocked = false;
      if (req && req.status === 'blocked') {
        const { error: updateReqError } = await supabaseAdmin
          .from('requirements')
          .update({ status: 'in-progress' })
          .eq('id', requirement_id);
          
        if (!updateReqError) {
          requirementUnblocked = true;
        }
      }

      return {
        success: true,
        message: `Successfully activated coding agents for requirement ${requirement_id}`,
        activated_instances: updatedInstances?.length || 0,
        activated_plans: updatedPlans.length,
        requirement_unblocked: requirementUnblocked,
        details: {
          instances: updatedInstances,
          plans: updatedPlans
        }
      };
    },
  };
}
