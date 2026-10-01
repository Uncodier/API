import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadRequirementMigrationHolds, migrationHoldContext } from '@/lib/services/requirement-execution-visibility';
import { HARNESS_DIAGNOSTIC_GUIDANCE } from '@/lib/services/harness-diagnostics/guidance';

export type AssistantRequirementContext = {
  activeRequirementId: string | null;
  requirementStatusContext: string;
  progressContext: string;
  backlogContext: string;
};

const TERMINAL_STAGES = new Set(['done', 'completed', 'cancelled', 'failed']);
const OPEN_REQUIREMENT_STATUSES = new Set([
  '',
  'backlog',
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
  let candidateId = requirementStatuses?.[0]?.requirement_id;
  if (!requirementStatuses?.length) {
    const { data: assigned, error } = await supabaseAdmin.from('requirements')
      .select('id')
      .eq('metadata->>runner_instance_id', instanceId)
      .in('status', ['backlog', 'pending', 'in-progress', 'blocked'])
      .limit(2);
    // Never guess between multiple requirements in a general chat session.
    if (error || assigned?.length !== 1) return empty;
    candidateId = assigned[0].id;
  }
  const latestStage = String(requirementStatuses?.[0]?.stage || '').toLowerCase();
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
  requirementStatusContext += '\n\n' + HARNESS_DIAGNOSTIC_GUIDANCE;
  try {
    requirementStatusContext += migrationHoldContext(await loadRequirementMigrationHolds(candidateId));
  } catch {
    requirementStatusContext += '\n\nExecution hold lookup is unavailable. Do not infer that execution is unblocked, resumed, or assigned from plan status or historical messages.';
  }
  requirementStatusContext += '\n\n📋 REQUIREMENT STATUS HISTORY:\n';
  requirementStatusContext += JSON.stringify(requirementStatuses, null, 2);
  requirementStatusContext +=
    '\n\n💡 CHANGE AND REPAIR REQUESTS: Distinguish a concrete scope change from generic "repair it", "apply it", or "continue". ' +
    'Generic repair requests preserve the existing specification, access model, execution history and recovery budgets. ' +
    'They are not evidence that an exhausted repair is impossible, permission to weaken security, a choice between product alternatives, or proof of missing credentials. ' +
    'Do not append generic approval to canonical instructions or recreate the requirement/backlog to reset attempts. ' +
    'Use the existing authorized resume/handoff path only; respect technical holds and do not claim a next agent is assigned without a persisted assignment. ' +
    'Only concrete new requirements belong in requirements(action="update"). If a genuine product choice or external capability is required, ' +
    'state the exact verified blocker and actionable options, not "may I repair SQL?". An apply request executes only a validated proposal; it never substitutes for validation.';

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
