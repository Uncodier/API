import { supabaseAdmin } from '@/lib/database/supabase-client';

export type AssistantRequirementContext = {
  activeRequirementId: string | null;
  requirementStatusContext: string;
  progressContext: string;
  backlogContext: string;
};

const TERMINAL_STAGES = new Set(['done', 'completed', 'cancelled', 'failed']);
const OPEN_REQUIREMENT_STATUSES = new Set([
  '',
  'pending',
  'in-progress',
  'blocked',
]);

/**
 * Resolve only a currently-open requirement for an interactive instance.
 * requirement_status is append-only, so historical terminal rows must never
 * leak requirement-scoped tools into an otherwise generic assistant session.
 */
export async function loadAssistantRequirementContext(
  instanceId: string,
): Promise<AssistantRequirementContext> {
  const { data: requirementStatuses } = await supabaseAdmin
    .from('requirement_status')
    .select('*')
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(10);

  const empty = {
    activeRequirementId: null,
    requirementStatusContext: '',
    progressContext: '',
    backlogContext: '',
  };
  if (!requirementStatuses || requirementStatuses.length === 0) return empty;

  const candidateId = requirementStatuses[0].requirement_id;
  const latestStage = String(requirementStatuses[0].stage || '').toLowerCase();
  if (!candidateId || TERMINAL_STAGES.has(latestStage)) return empty;

  const { data: reqRow } = await supabaseAdmin
    .from('requirements')
    .select('status, title, description, instructions, type, priority')
    .eq('id', candidateId)
    .maybeSingle();
  const requirementStatus = String(reqRow?.status || '').toLowerCase();
  if (!OPEN_REQUIREMENT_STATUSES.has(requirementStatus)) {
    console.log(
      `[AssistantContext] Skipping activeRequirementId=${candidateId}: ` +
        `requirement is terminal (${requirementStatus}). Avoiding cross-project context leak.`,
    );
    return empty;
  }

  let requirementStatusContext = '\n\n📋 CURRENT REQUIREMENT CONTEXT:\n';
  requirementStatusContext += JSON.stringify(reqRow, null, 2);
  requirementStatusContext += '\n\n📋 REQUIREMENT STATUS HISTORY:\n';
  requirementStatusContext += JSON.stringify(requirementStatuses, null, 2);
  requirementStatusContext +=
    '\n\n💡 WHEN CHANGES ARE REQUESTED: If the user requests changes, you MUST use ' +
    'the requirements tool (action="update") to update the requirement instructions ' +
    'with the new requests and set its status to "in-progress". Then, use the ' +
    'requirement_status tool (action="create") to log that the requirement is back in progress.';

  const { data: reqData } = await supabaseAdmin
    .from('requirements')
    .select('progress, backlog')
    .eq('id', candidateId)
    .single();

  let progressContext = '';
  if (Array.isArray(reqData?.progress) && reqData.progress.length > 0) {
    progressContext = '\n\n📋 RECENT REQUIREMENT PROGRESS:\n';
    progressContext += JSON.stringify(reqData.progress.slice(-5), null, 2);
  }

  let backlogContext = '';
  if (Array.isArray(reqData?.backlog?.items)) {
    const inProgressItem = reqData.backlog.items.find(
      (item: { status?: string }) => item.status === 'in_progress',
    );
    if (inProgressItem) {
      backlogContext = '\n\n📋 CURRENT BACKLOG ITEM (IN_PROGRESS):\n';
      backlogContext += JSON.stringify(inProgressItem, null, 2);
    }
  }

  return {
    activeRequirementId: candidateId,
    requirementStatusContext,
    progressContext,
    backlogContext,
  };
}
