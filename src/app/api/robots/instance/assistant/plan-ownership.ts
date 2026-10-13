import { supabaseAdmin } from '@/lib/database/supabase-client';

export type AssistantPlanOwnership =
  | { state: 'standalone' }
  | { state: 'managed'; requirementId: string; runnable: boolean }
  | { state: 'unavailable'; reason: string };

export type AssistantPlanOwnershipInput = {
  instanceId: string;
  siteId: string;
  planRequirementId?: string;
  contextRequirementId?: string;
  contextHasLinkedRequirement?: boolean;
};

const OPEN_STATUSES = ['backlog', 'pending', 'in-progress', 'blocked'];
const TERMINAL_STAGES = new Set(['done', 'completed', 'cancelled', 'failed']);

/** Admission only, never a claim or a resume. Read again after the conversation:
 * it may have created a requirement while its serialized context stayed generic.
 * Missing/ambiguous ownership must not authorize the interactive executor.
 */
export async function resolveAssistantPlanOwnership(
  input: AssistantPlanOwnershipInput,
): Promise<AssistantPlanOwnership> {
  const unavailable = (reason: string): AssistantPlanOwnership => ({ state: 'unavailable', reason });
  try {
    const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
      .select('id,status,is_archived').eq('id', input.instanceId).eq('site_id', input.siteId).maybeSingle();
    if (instanceError || !instance) return unavailable('instance_lookup_failed');
    if (instance.is_archived || ['paused', 'stopped', 'stopping'].includes(instance.status)) {
      return unavailable('instance_inactive');
    }

    const refs = [input.planRequirementId, input.contextRequirementId].filter(Boolean) as string[];
    if (new Set(refs).size > 1) return unavailable('conflicting_requirement_bindings');

    // The INSERT assigns the original instance before a status row or plan exists.
    const { data: assigned, error: assignedError } = await supabaseAdmin.from('requirements')
      .select('id').eq('site_id', input.siteId).eq('metadata->>runner_instance_id', input.instanceId)
      .in('status', OPEN_STATUSES).limit(2);
    if (assignedError || !Array.isArray(assigned)) return unavailable('ownership_lookup_failed');
    if (assigned.length > 1 || (refs[0] && assigned[0] && assigned[0].id !== refs[0])) {
      return unavailable('ambiguous_requirement_assignment');
    }
    let requirementId = refs[0] || assigned[0]?.id;
    if (!requirementId) {
      const { data: history, error: historyError } = await supabaseAdmin.from('requirement_status')
        .select('requirement_id,stage').eq('site_id', input.siteId).eq('instance_id', input.instanceId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
      if (historyError || !Array.isArray(history)) return unavailable('ownership_lookup_failed');
      if (history[0] && !TERMINAL_STAGES.has(String(history[0].stage).toLowerCase())) {
        requirementId = history[0].requirement_id;
      }
    }
    if (!requirementId) {
      return input.contextHasLinkedRequirement
        ? unavailable('requirement_binding_disappeared') : { state: 'standalone' };
    }
    const { data: requirement, error } = await supabaseAdmin.from('requirements')
      .select('id,status,metadata').eq('id', requirementId).eq('site_id', input.siteId).maybeSingle();
    if (error || !requirement) return unavailable('requirement_lookup_failed');
    if (!refs.length && !assigned.length && !input.contextHasLinkedRequirement &&
        TERMINAL_STAGES.has(requirement.status)) {
      // Legacy history can lag the requirement's terminal state. It must not
      // capture a new, unbound standalone plan in this same conversation.
      return { state: 'standalone' };
    }
    const owner = requirement.metadata?.runner_instance_id;
    if (owner && owner !== input.instanceId) return unavailable('requirement_owner_changed');
    // Even a terminal/blocked requirement's explicitly bound plan is never a
    // standalone plan. Completing a chat response does not reopen that work.
    return { state: 'managed', requirementId, runnable: ['backlog', 'in-progress'].includes(requirement.status) };
  } catch {
    return unavailable('ownership_lookup_failed');
  }
}