import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

type RequirementRunnerScope = {
  id: string;
  site_id: string;
  metadata?: Record<string, any> | null;
};

export type RequirementRunnerHandoff = {
  instanceId?: string;
  archivedInstanceId?: string;
  skipReason?: string;
};

/** Read-only admission check, before preparation or creating a remote instance.
 * The SQL ownership assertion repeats the action check at tool dispatch.
 * A finished assistant turn may hand its plan to cron on the SAME instance.
 * Silence, a provider timeout, or a paused action never authorizes replacement.
 * Explicit archival is different: cron may replace it through the leased,
 * atomic replacement RPC, never by clearing ownership or inserting a fallback.
 */
export async function inspectRequirementRunnerHandoff(
  requirement: RequirementRunnerScope,
  resolvedInstanceId?: string,
): Promise<RequirementRunnerHandoff> {
  const origin = requirement.metadata?.assistant_origin_instance_id;
  let instanceId = resolvedInstanceId || requirement.metadata?.runner_instance_id || origin;
  try {
    if (!instanceId) {
      // Legacy assistants linked plans before writing their first status row.
      // Check those plans BEFORE the canonical cron name, not after creating it.
      const { data: plans, error } = await supabaseAdmin.from('instance_plans')
        .select('instance_id')
        .eq('site_id', requirement.site_id)
        .eq('metadata->>requirement_id', requirement.id)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (error) return { skipReason: 'instance_history_unavailable' };
      const ids = Array.from(new Set((plans || []).map(plan => plan.instance_id).filter(Boolean)));
      if (ids.length) {
        const { data: instances, error: instanceError } = await supabaseAdmin
          .from('remote_instances').select('id, name')
          .eq('site_id', requirement.site_id).in('id', ids);
        if (instanceError) return { skipReason: 'instance_history_unavailable' };
        const owners = new Set((instances || [])
          .filter(instance => !instance.name?.startsWith('req-maint-'))
          .map(instance => instance.id));
        instanceId = ids.find(id => owners.has(id));
        const foundIds = new Set((instances || []).map(instance => instance.id));
        if (!instanceId && ids.every(id => foundIds.has(id))) {
          // Known maintenance-only history is not evidence of a missing main
          // owner. Let the caller look up the existing canonical runner.
          return {};
        }
        // A missing historical owner is not proof that starting another is safe.
        if (!instanceId) return { skipReason: 'original_instance_unavailable' };
      }
    }
    if (!instanceId) return {};

    const { data, error } = await supabaseAdmin.rpc(
      'inspect_requirement_assistant_handoff',
      { p_requirement_id: requirement.id, p_instance_id: instanceId },
    );
    if (error || typeof data?.allowed !== 'boolean') {
      return { instanceId, skipReason: 'assistant_handoff_unavailable' };
    }
    if (!data.allowed && data.reason === 'original_instance_archived') {
      return { instanceId, archivedInstanceId: instanceId };
    }
    return data.allowed
      ? { instanceId }
      : { instanceId, skipReason: data.reason || 'assistant_handoff_not_confirmed' };
  } catch {
    return { instanceId, skipReason: 'assistant_handoff_unavailable' };
  }
}

const replacementReceiptSchema = z.object({
  state: z.enum(['replaced', 'duplicate']),
  instance_id: z.string().uuid(),
  execution_generation: z.number().int().nonnegative(),
  metadata: z.record(z.any()),
});

/** Creation, ownership, fencing and plan transfer must commit together in SQL. */
export async function replaceArchivedRequirementRunner(input: {
  requirementId: string;
  runId: string;
  archivedInstanceId: string;
  executionGeneration: number;
}): Promise<{
  instanceId?: string;
  metadata?: Record<string, any>;
  skipReason?: string;
}> {
  try {
    const { data, error } = await supabaseAdmin.rpc('replace_archived_requirement_runner', {
      p_requirement_id: input.requirementId,
      p_run_id: input.runId,
      p_expected_instance_id: input.archivedInstanceId,
      p_expected_execution_generation: input.executionGeneration,
    });
    if (error) return { skipReason: 'archived_runner_replacement_unavailable' };
    if (data?.state === 'guarded') {
      return { skipReason: 'archived_runner_replacement_guarded' };
    }
    const receipt = replacementReceiptSchema.safeParse(data);
    if (!receipt.success || receipt.data.instance_id === input.archivedInstanceId ||
        receipt.data.execution_generation !== input.executionGeneration + 1 ||
        receipt.data.metadata.runner_instance_id !== receipt.data.instance_id ||
        receipt.data.metadata.requirement_execution_generation !== receipt.data.execution_generation) {
      return { skipReason: 'archived_runner_replacement_unconfirmed' };
    }
    return { instanceId: receipt.data.instance_id, metadata: receipt.data.metadata };
  } catch {
    return { skipReason: 'archived_runner_replacement_unavailable' };
  }
}
