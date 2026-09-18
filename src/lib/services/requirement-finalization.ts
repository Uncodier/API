import { supabaseAdmin } from '@/lib/database/supabase-client';

export type RequirementFinalStatus =
  | 'done'
  | 'in-progress'
  | 'blocked'
  | 'on-review';

export interface RequirementFinalizationResult {
  state: 'applied' | 'stale' | 'missing' | 'guarded';
  effectiveStatus: RequirementFinalStatus;
  statusId?: string;
}

const FINAL_STATUSES: RequirementFinalStatus[] = [
  'done',
  'in-progress',
  'blocked',
  'on-review',
];

export async function finalizeRequirementExecution(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  expectedExecutionGeneration: number;
  eventId: string;
  existingStatusId?: string | null;
  status: RequirementFinalStatus;
  message: string;
  repoUrl?: string | null;
  previewUrl?: string | null;
  sourceCodeUrl?: string | null;
  snapshotId?: string | null;
  isComplete: boolean;
  markOnReview: boolean;
}): Promise<RequirementFinalizationResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'finalize_requirement_execution_atomic',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId,
      p_expected_execution_generation: params.expectedExecutionGeneration,
      p_event_id: params.eventId,
      p_existing_status_id: params.existingStatusId ?? null,
      p_stage: params.status,
      p_message: params.message,
      p_repo_url: params.repoUrl ?? null,
      p_preview_url: params.previewUrl ?? null,
      p_source_code: params.sourceCodeUrl ?? null,
      p_snapshot_id: params.snapshotId ?? null,
      p_is_complete: params.isComplete,
      p_mark_on_review: params.markOnReview,
    },
  );
  if (error) {
    throw new Error(`Atomic requirement finalization failed: ${error.message}`);
  }
  if (
    !data ||
    !['applied', 'stale', 'missing', 'guarded'].includes(data.state) ||
    !FINAL_STATUSES.includes(data.effective_status)
  ) {
    throw new Error('Requirement finalization RPC returned an invalid result');
  }
  return {
    state: data.state,
    effectiveStatus: data.effective_status,
    statusId:
      typeof data.status_id === 'string' ? data.status_id : undefined,
  } as RequirementFinalizationResult;
}
