import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resumeRequirementExecutionOnUserAction } from '@/lib/services/requirement-execution-recovery';
import { listMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';

export interface ActivateCodingAgentsParams {
  requirement_id: string;
}

export function activateCodingAgentsTool(siteId: string, instanceId: string) {
  return {
    name: 'activate_coding_agents',
    description:
      'Resume a requirement only in its assigned instance, using the current trusted user instruction. Never starts another instance or resumes all agents. If another instance owns the requirement, send the instruction there instead.',
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

      const { data: requirement, error } = await supabaseAdmin.from('requirements')
        .select('id, status, metadata')
        .eq('id', requirement_id).eq('site_id', siteId).maybeSingle();
      if (error || !requirement) throw new Error('Requirement is unavailable in this site');
      const owner = requirement.metadata?.runner_instance_id;
      const guarded = (reason: string) => ({
        success: false, reason, owner_instance_id: owner || null,
        activated_instances: 0, activated_plans: 0, requirement_unblocked: false,
      });
      // Names cannot establish ownership: a historical duplicate may be named
      // req-runner even though another instance created the work.
      if (!owner) return guarded('requirement_owner_not_confirmed');
      if (owner !== instanceId) return guarded('requirement_owned_by_another_instance');
      const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
        .select('id, is_archived').eq('id', owner).eq('site_id', siteId).maybeSingle();
      if (instanceError || !instance || instance.is_archived) return guarded('original_instance_unavailable');
      const migrations = await listMigrationLifecycle(requirement_id);
      if (migrations.some(migration => migration.state !== 'validated' && migration.state !== 'transferred')) {
        return guarded('migration_review_pending');
      }
      const { data: action, error: actionError } = await supabaseAdmin.from('instance_logs')
        .select('id, details').eq('instance_id', instanceId).eq('site_id', siteId)
        .eq('log_type', 'user_action').eq('trusted_user_action', true)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1).maybeSingle();
      if (actionError || !action || action.details?.requirement_id !== requirement_id ||
          action.details?.status !== 'running') return guarded('trusted_requirement_action_required');
      // The scoped RPC alone reopens plans and enforces review/terminal guards.
      // A status update would not actually start work and could wake duplicates.
      const recovery = await resumeRequirementExecutionOnUserAction(
        requirement_id, instanceId, true, action.id,
      );
      if (!['applied', 'duplicate'].includes(recovery.state)) return guarded(`recovery_${recovery.state}`);
      return {
        success: true,
        message: 'Recovery applied to the existing owner; no parallel instance was started.',
        owner_instance_id: instanceId,
        activated_instances: 0,
        activated_plans: recovery.plans_updated,
        requirement_unblocked: recovery.state === 'applied' && requirement.status === 'blocked',
      };
    },
  };
}
