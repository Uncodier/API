import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { CronInfrastructureWait } from './cron-infrastructure-state';

export type InfrastructureMutationState =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'terminal'
  | 'missing';

export interface InfrastructureFailureMutation {
  state: InfrastructureMutationState;
  infra_count: number;
  circuit_open: boolean;
  retry_at?: string | null;
  generation?: number;
}

export interface InfrastructureClearMutation {
  state: InfrastructureMutationState;
  cleared: boolean;
  generation?: number;
}

export interface PlanStepStatusMutation {
  state: InfrastructureMutationState | 'duplicate';
  persisted: boolean;
  generation?: number;
}

export interface PlanStepPatchMutation {
  state: InfrastructureMutationState;
  persisted: boolean;
  generation?: number;
}

export interface PlanRepairStepMutation extends PlanStepPatchMutation {
  step_id?: string;
}

export interface PlanStepCompletionMutation {
  state: PlanStepStatusMutation['state'] | 'guarded';
  persisted: boolean;
  generation?: number;
  final: boolean;
}

export interface InfrastructureBlockMutation {
  state: InfrastructureMutationState | 'guarded';
  blocked: boolean;
  generation?: number;
}

export interface ScopedBacklogBlockMutation {
  state:
    | InfrastructureMutationState
    | 'guarded'
    | 'no_alternative'
    | 'unsupported';
  isolated: boolean;
  affected_item_ids: string[];
  generation?: number;
}

export class InfrastructureStateDatabaseError extends Error {
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(
    operation: string,
    error: { message: string; code?: string; details?: string; hint?: string },
  ) {
    super(`${operation}: ${error.message}`);
    this.name = 'InfrastructureStateDatabaseError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = error.code;
    this.details = error.details;
    this.hint = error.hint;
  }
}

export async function recordPlanStepInfrastructureFailure(params: {
  planId: string;
  stepId: string;
  eventId: string;
  errorMessage?: string;
  wait?: CronInfrastructureWait;
  maxRetries: number;
  expectedGeneration: number;
  allowRetryableFailed?: boolean;
}): Promise<InfrastructureFailureMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'record_instance_plan_step_infrastructure_failure',
    {
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_event_id: params.eventId,
      p_error_message: params.errorMessage ?? null,
      p_wait: params.wait ?? {},
      p_max_retries: params.maxRetries,
      p_expected_generation: params.expectedGeneration,
      p_allow_retryable_failed: params.allowRetryableFailed ?? false,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to record plan infrastructure failure',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.infra_count !== 'number'
  ) {
    throw new Error('Infrastructure failure RPC returned an invalid result');
  }
  return data as InfrastructureFailureMutation;
}

export async function clearPlanStepInfrastructureState(params: {
  planId: string;
  stepId: string;
  eventId: string;
  expectedGeneration: number;
}): Promise<InfrastructureClearMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'clear_instance_plan_step_infrastructure_state',
    {
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_event_id: params.eventId,
      p_expected_generation: params.expectedGeneration,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to clear plan infrastructure state',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.cleared !== 'boolean'
  ) {
    throw new Error('Infrastructure clear RPC returned an invalid result');
  }
  return data as InfrastructureClearMutation;
}

export async function updatePlanStepStatusAtomically(params: {
  planId: string;
  stepId: string;
  status: string;
  errorMessage?: string;
  expectedGeneration: number;
}): Promise<PlanStepStatusMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'update_instance_plan_step_status_atomic',
    {
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_status: params.status,
      p_error_message: params.errorMessage ?? null,
      p_expected_generation: params.expectedGeneration,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to persist plan step status',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.persisted !== 'boolean'
  ) {
    throw new Error('Plan step status RPC returned an invalid result');
  }
  return data as PlanStepStatusMutation;
}

export async function completePlanStepAfterGateAtomically(params: {
  planId: string;
  stepId: string;
  expectedGeneration: number;
  finalGateApproved: boolean;
}): Promise<PlanStepCompletionMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'complete_instance_plan_step_after_gate',
    {
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_expected_generation: params.expectedGeneration,
      p_final_gate_approved: params.finalGateApproved,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to complete plan step after gate',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.persisted !== 'boolean' ||
    typeof data.final !== 'boolean'
  ) {
    throw new Error('Plan step completion RPC returned an invalid result');
  }
  return data as PlanStepCompletionMutation;
}

export async function patchPlanStepAtomically(params: {
  planId: string;
  stepId: string;
  expectedGeneration: number;
  eventId: string;
  patch: Record<string, unknown>;
}): Promise<PlanStepPatchMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'patch_instance_plan_step_atomic',
    {
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_expected_generation: params.expectedGeneration,
      p_event_id: params.eventId,
      p_patch: params.patch,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to atomically patch plan step',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.persisted !== 'boolean'
  ) {
    throw new Error('Plan step patch RPC returned an invalid result');
  }
  return data as PlanStepPatchMutation;
}

export async function appendPlanRepairStepAtomically(params: {
  planId: string;
  sourceStepId: string;
  expectedSourceGeneration: number;
  repairRunId: string;
  repairStep: Record<string, unknown>;
}): Promise<PlanRepairStepMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'append_instance_plan_repair_step_atomic',
    {
      p_plan_id: params.planId,
      p_source_step_id: params.sourceStepId,
      p_expected_source_generation: params.expectedSourceGeneration,
      p_repair_run_id: params.repairRunId,
      p_repair_step: params.repairStep,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to atomically append plan repair step',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.persisted !== 'boolean'
  ) {
    throw new Error('Plan repair step RPC returned an invalid result');
  }
  return data as PlanRepairStepMutation;
}

export async function blockRequirementForInfrastructureCircuit(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  planId: string;
  stepId: string;
  expectedGeneration: number;
  provenance: string;
  message: string;
  eventId: string;
  expectedExecutionGeneration: number;
}): Promise<InfrastructureBlockMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'block_requirement_for_infrastructure_circuit',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId,
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_expected_generation: params.expectedGeneration,
      p_provenance: params.provenance,
      p_message: params.message,
      p_event_id: params.eventId,
      p_expected_execution_generation: params.expectedExecutionGeneration,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to persist infrastructure circuit blocker',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.blocked !== 'boolean'
  ) {
    throw new Error('Infrastructure blocker RPC returned an invalid result');
  }
  return data as InfrastructureBlockMutation;
}

export async function blockBacklogItemForCircuitAtomically(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  planId: string;
  stepId: string;
  backlogItemId: string;
  expectedStepGeneration: number;
  expectedExecutionGeneration: number;
  circuitKind: 'infrastructure' | 'product_no_progress';
  blockerId: string;
  category: 'product_defect' | 'infrastructure_unavailable';
  reason: string;
  resolutionActor: 'executor' | 'platform';
  retryAfter?: string;
  provenance?: string;
  cycleId?: string;
  minimumFailures?: number;
  attemptLimits: { core: number; ornamental: number };
}): Promise<ScopedBacklogBlockMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'block_backlog_item_for_circuit_atomic',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId,
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_backlog_item_id: params.backlogItemId,
      p_expected_step_generation: params.expectedStepGeneration,
      p_expected_execution_generation: params.expectedExecutionGeneration,
      p_circuit_kind: params.circuitKind,
      p_blocker_id: params.blockerId,
      p_category: params.category,
      p_reason: params.reason,
      p_resolution_actor: params.resolutionActor,
      p_retry_after: params.retryAfter ?? null,
      p_provenance: params.provenance ?? null,
      p_cycle_id: params.cycleId ?? null,
      p_minimum_failures: params.minimumFailures ?? null,
      p_core_attempt_limit: params.attemptLimits.core,
      p_ornamental_attempt_limit: params.attemptLimits.ornamental,
    },
  );
  if (error) {
    if (
      error.code === 'PGRST202' ||
      /block_backlog_item_for_circuit_atomic/i.test(error.message) &&
        /not find|does not exist|schema cache/i.test(error.message)
    ) {
      return {
        state: 'unsupported',
        isolated: false,
        affected_item_ids: [],
      };
    }
    throw new InfrastructureStateDatabaseError(
      'Failed to atomically isolate backlog circuit',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.isolated !== 'boolean' ||
    !Array.isArray(data.affected_item_ids)
  ) {
    throw new Error('Scoped backlog circuit RPC returned an invalid result');
  }
  return data as ScopedBacklogBlockMutation;
}

export async function blockRequirementForCronInfrastructureCycles(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  cycleId: string;
  minimumFailures: number;
  message: string;
  expectedExecutionGeneration: number;
}): Promise<InfrastructureBlockMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'block_requirement_for_cron_infrastructure_cycles',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId,
      p_cycle_id: params.cycleId,
      p_minimum_failures: params.minimumFailures,
      p_message: params.message,
      p_expected_execution_generation: params.expectedExecutionGeneration,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to persist cron infrastructure circuit',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.blocked !== 'boolean'
  ) {
    throw new Error('Cron infrastructure circuit RPC returned an invalid result');
  }
  return data as InfrastructureBlockMutation;
}

export async function blockRequirementForProductNoProgress(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  planId: string;
  stepId: string;
  expectedStepGeneration: number;
  cycleId: string;
  minimumFailures: number;
  message: string;
  expectedExecutionGeneration: number;
}): Promise<InfrastructureBlockMutation> {
  const { data, error } = await supabaseAdmin.rpc(
    'block_requirement_for_product_no_progress',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId,
      p_cycle_id: params.cycleId,
      p_minimum_failures: params.minimumFailures,
      p_message: params.message,
      p_expected_execution_generation: params.expectedExecutionGeneration,
      p_plan_id: params.planId,
      p_step_id: params.stepId,
      p_expected_step_generation: params.expectedStepGeneration,
    },
  );
  if (error) {
    throw new InfrastructureStateDatabaseError(
      'Failed to persist product no-progress circuit',
      error,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.blocked !== 'boolean'
  ) {
    throw new Error('Product no-progress circuit RPC returned an invalid result');
  }
  return data as InfrastructureBlockMutation;
}
