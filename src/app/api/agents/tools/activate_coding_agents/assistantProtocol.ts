import { supabaseAdmin } from '@/lib/database/supabase-client';
import { submitRequirementCommand, type RequirementCommandSource } from '@/lib/services/requirement-command';
import { listMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';

export interface ActivateCodingAgentsParams {
  requirement_id: string;
}

export function activateCodingAgentsTool(siteId: string, instanceId: string, commandSource?: RequirementCommandSource) {
  // Capture the host identity, never discover authority from the latest log or
  // accept action/user identity from model arguments.
  const source = commandSource ? { ...commandSource } : undefined;
  return {
    name: 'activate_coding_agents',
    description:
      'Request an explicit retry of existing requirement work in its assigned instance using the current trusted user message. Queues the request for the sole runner after the conversation finishes; does not immediately start execution, publish a preview, clear review holds or release explicit pauses. Use only when the user asks to retry/continue, never for status questions. Use requirements action="update" instead if scope also changes, consolidating changes and retry in one command per user message. Inspect the returned command diagnostic; do not resubmit a queued request. If another instance owns the requirement, send the instruction there instead.',
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
        activated_instances: 0, activated_plans: 0, requirement_unblocked: false, execution_started: false,
      });
      // Names cannot establish ownership: a historical duplicate may be named
      // req-runner even though another instance created the work.
      if (!owner) return guarded('requirement_owner_not_confirmed');
      if (owner !== instanceId) return guarded('requirement_owned_by_another_instance');
      if (!source || source.siteId !== siteId || source.instanceId !== instanceId) {
        return guarded('trusted_requirement_action_required');
      }
      if (['done', 'cancelled', 'canceled'].includes(requirement.status)) return guarded('requirement_terminal');
      const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
        .select('id, is_archived').eq('id', owner).eq('site_id', siteId).maybeSingle();
      if (instanceError || !instance || instance.is_archived) return guarded('original_instance_unavailable');
      const migrations = await listMigrationLifecycle(requirement_id);
      if (migrations.some(migration => migration.state !== 'validated' && migration.state !== 'transferred')) {
        return guarded('migration_review_pending');
      }
      // Admission validates the exact persisted message, actor/site access and
      // instance scope atomically and stores a requirement-scoped receipt. The
      // scheduler applies it only at its safe boundary; no log mutation or direct
      // recovery RPC may revoke a healthy lease or bypass a user pause here.
      const receipt = await submitRequirementCommand(requirement_id,
        { status: 'in-progress', completion_status: 'pending' }, source);
      return {
        success: true,
        message: 'Retry request persisted for the existing owner. Execution has not started. Read command.diagnostic for holds or eligibility; finish this conversation so the scheduler can process eligible work. Do not resubmit or claim a preview was published.',
        command: receipt.command,
        owner_instance_id: instanceId,
        activated_instances: 0,
        activated_plans: 0,
        requirement_unblocked: false,
        execution_started: false,
      };
    },
  };
}
