import { supabaseAdmin } from '@/lib/database/supabase-client';

export type CronCycleOutcome =
  | 'progress'
  | 'product_no_progress'
  | 'product_failure'
  | 'infrastructure_wait'
  | 'infrastructure_retry'
  | 'infrastructure_exhausted'
  | 'scheduler_cooldown'
  | 'remediation_handoff'
  | 'paused'
  | 'idle';

export interface CronCycleAccountingResult {
  accepted: boolean;
  is_latest: boolean;
  recorded_outcome: CronCycleOutcome;
  metadata: Record<string, unknown>;
  cron_attempts: number;
  no_progress_cycles: number;
  infrastructure_failure_cycles: number;
}

export interface RequirementBlockResult {
  state: 'applied' | 'guarded' | 'missing' | 'stale';
  blocked: boolean;
}

export async function patchRequirementMetadataKeys(params: {
  requirementId: string;
  patch?: Record<string, unknown>;
  removeKeys?: string[];
}): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin.rpc(
    'patch_requirement_metadata_keys',
    {
      p_requirement_id: params.requirementId,
      p_patch: params.patch ?? {},
      p_remove_keys: params.removeKeys ?? [],
    },
  );
  if (error) {
    throw new Error(
      `Failed to atomically patch requirement metadata: ${error.message}`,
    );
  }
  return (data ?? {}) as Record<string, unknown>;
}

export async function incrementRequirementMetadataCounter(params: {
  requirementId: string;
  key: string;
  increment?: number;
  initialValue?: number;
}): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc(
    'increment_requirement_metadata_counter',
    {
      p_requirement_id: params.requirementId,
      p_key: params.key,
      p_increment: params.increment ?? 1,
      p_initial_value: params.initialValue ?? 0,
    },
  );
  if (error) {
    throw new Error(
      `Failed to atomically increment requirement metadata: ${error.message}`,
    );
  }
  if (typeof data !== 'number') {
    throw new Error('Metadata counter RPC returned a non-numeric value');
  }
  return data;
}

export async function recordRequirementCronCycleOutcome(params: {
  requirementId: string;
  cycleId: string;
  cycleStartedAt: string;
  outcome: CronCycleOutcome;
  expectedExecutionGeneration: number;
  runnerInstanceId?: string;
}): Promise<CronCycleAccountingResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'record_requirement_cron_cycle_outcome',
    {
      p_requirement_id: params.requirementId,
      p_cycle_id: params.cycleId,
      p_cycle_started_at: params.cycleStartedAt,
      p_outcome: params.outcome,
      p_expected_execution_generation: params.expectedExecutionGeneration,
      p_runner_instance_id: params.runnerInstanceId ?? null,
    },
  );
  if (error) {
    throw new Error(
      `Failed to record cron cycle outcome: ${error.message}`,
    );
  }
  if (
    !data ||
    typeof data.accepted !== 'boolean' ||
    typeof data.is_latest !== 'boolean' ||
    typeof data.cron_attempts !== 'number' ||
    typeof data.no_progress_cycles !== 'number' ||
    typeof data.infrastructure_failure_cycles !== 'number'
  ) {
    throw new Error('Cron cycle accounting RPC returned an invalid result');
  }
  return data as CronCycleAccountingResult;
}

export async function blockRequirementForProductAttemptBudget(params: {
  requirementId: string;
  siteId: string;
  instanceId?: string;
  cycleId: string;
  maxAttempts: number;
  message: string;
  expectedExecutionGeneration: number;
}): Promise<RequirementBlockResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'block_requirement_for_product_attempt_budget',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId ?? null,
      p_cycle_id: params.cycleId,
      p_max_attempts: params.maxAttempts,
      p_message: params.message,
      p_expected_execution_generation: params.expectedExecutionGeneration,
    },
  );
  if (error) {
    throw new Error(
      `Failed to persist product attempt circuit: ${error.message}`,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.blocked !== 'boolean'
  ) {
    throw new Error('Product attempt circuit RPC returned an invalid result');
  }
  return data as RequirementBlockResult;
}

export async function blockRequirementWithProvenance(params: {
  requirementId: string;
  siteId: string;
  instanceId?: string;
  provenance: string;
  message: string;
  eventId: string;
  expectedExecutionGeneration: number;
}): Promise<RequirementBlockResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'block_requirement_with_provenance',
    {
      p_requirement_id: params.requirementId,
      p_site_id: params.siteId,
      p_instance_id: params.instanceId ?? null,
      p_provenance: params.provenance,
      p_message: params.message,
      p_event_id: params.eventId,
      p_expected_execution_generation: params.expectedExecutionGeneration,
    },
  );
  if (error) {
    throw new Error(
      `Failed to atomically block requirement: ${error.message}`,
    );
  }
  if (
    !data ||
    typeof data.state !== 'string' ||
    typeof data.blocked !== 'boolean'
  ) {
    throw new Error('Requirement block RPC returned an invalid result');
  }
  return data as RequirementBlockResult;
}
