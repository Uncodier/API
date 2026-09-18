import { supabaseAdmin } from '@/lib/database/supabase-client';
import { type PlanExecutionHaltReason } from './cron-execute-steps-phase';
import { type Sandbox } from '@vercel/sandbox';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { runOrchestratorStep } from './cron-orchestrator-step';
import { PLAN_STEP_MAX_RETRIES } from '@/lib/helpers/plan-status';
import {
  type CronInfrastructureWait,
} from '@/lib/services/cron-infrastructure-state';
import {
  blockRequirementForCronInfrastructureCycles,
  blockRequirementForInfrastructureCircuit,
  blockRequirementForProductNoProgress,
  clearPlanStepInfrastructureState,
  InfrastructureStateDatabaseError,
  patchPlanStepAtomically,
  type InfrastructureBlockMutation,
  type InfrastructureFailureMutation,
  type PlanStepStatusMutation,
  recordPlanStepInfrastructureFailure,
  updatePlanStepStatusAtomically,
} from '@/lib/services/instance-plan-infrastructure-state';

export type PlanGate =
  | { runnable: true; dbStatus: string }
  | {
      runnable: false;
      reason: PlanExecutionHaltReason;
      infrastructureKind?: string;
      infrastructureProvenance?: string;
      infrastructureGeneration?: number;
    };

export function getPlanExecutionGateFromStatus(status: string | undefined | null): PlanGate {
  if (status === undefined || status === null) {
    return { runnable: false, reason: 'missing' };
  }
  if (status === 'paused') return { runnable: false, reason: 'paused' };
  if (status === 'cancelled') return { runnable: false, reason: 'cancelled' };
  if (status === 'pending' || status === 'in_progress') {
    return { runnable: true, dbStatus: status };
  }
  return { runnable: false, reason: 'terminal' };
}

export function selectPlanStepsForExecution(steps: any[]): any[] {
  const byOrder = (a: any, b: any) => (a.order || 0) - (b.order || 0);
  const retries = steps
    .filter(
      (step) =>
        step.status === 'failed' &&
        (step.retry_count ?? 0) < PLAN_STEP_MAX_RETRIES,
    )
    .sort(byOrder);
  const pending = steps
    .filter(
      (step) =>
        step.status === 'pending' || step.status === 'in_progress',
    )
    .sort(byOrder);
  return [...retries, ...pending];
}

export async function getPlanExecutionGateStep(
  planId: string,
  expectedStepId?: string,
): Promise<PlanGate> {
  'use step';
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('status, steps')
    .eq('id', planId)
    .maybeSingle();
  if (error) {
    throw new InfrastructureStateDatabaseError(
      `Failed to load plan execution gate ${planId}`,
      error,
    );
  }
  if (!data) {
    return { runnable: false, reason: 'missing' };
  }
  const statusGate = getPlanExecutionGateFromStatus(data.status);
  if (!statusGate.runnable) return statusGate;

  const activeStep = selectPlanStepsForExecution(
    Array.isArray(data.steps) ? data.steps : [],
  )[0];
  if (expectedStepId && activeStep?.id !== expectedStepId) {
    return { runnable: false, reason: 'step_changed' };
  }
  if (
    activeStep?.infrastructure_circuit_open === true ||
    activeStep?.infrastructure_state === 'intervention_required' ||
    (activeStep?.infra_retry_count ?? 0) >= MAX_INFRA_RETRIES
  ) {
    return {
      runnable: false,
      reason: 'infrastructure_circuit_open',
      infrastructureKind: activeStep?.infrastructure_kind,
      infrastructureProvenance:
        activeStep?.infrastructure_failure_provenance,
      infrastructureGeneration:
        Number(activeStep?.infrastructure_generation || 0),
    };
  }
  if (activeStep && !isStepInfraRetryDue(activeStep)) {
    return {
      runnable: false,
      reason: 'infrastructure_wait',
      infrastructureKind: activeStep.infrastructure_kind,
      infrastructureProvenance:
        activeStep.infrastructure_failure_provenance,
    };
  }
  return statusGate;
}

export async function updatePlanStepStatusStep(
  planId: string,
  stepId: string,
  status: string,
  errorMessage?: string,
  expectedGeneration = 0,
): Promise<PlanStepStatusMutation> {
  'use step';
  return updatePlanStepStatusAtomically({
    planId,
    stepId,
    status,
    errorMessage,
    expectedGeneration,
  });
}

export const MAX_INFRA_RETRIES = 4;

export function isStepInfraRetryDue(
  step: { infra_retry_after?: unknown },
  nowMs: number = Date.now(),
): boolean {
  if (typeof step.infra_retry_after !== 'string') return true;
  const retryAt = Date.parse(step.infra_retry_after);
  return !Number.isFinite(retryAt) || retryAt <= nowMs;
}

export async function recordStepInfraTransientStep(
  planId: string,
  stepId: string,
  eventId: string,
  errorMessage?: string,
  wait?: CronInfrastructureWait,
  options: {
    allowRetryableFailed?: boolean;
    expectedGeneration?: number;
  } = {},
): Promise<{
  /** True when the bounded infrastructure retry budget has been exhausted. */
  exhausted: boolean;
  circuitOpen: boolean;
  infraCount: number;
  retryAt?: string;
  generation?: number;
  state: InfrastructureFailureMutation['state'];
}> {
  'use step';
  const result = await recordPlanStepInfrastructureFailure({
    planId,
    stepId,
    eventId,
    errorMessage,
    wait,
    maxRetries: MAX_INFRA_RETRIES,
    expectedGeneration: options.expectedGeneration ?? 0,
    allowRetryableFailed: options.allowRetryableFailed,
  });
  return {
    exhausted: result.circuit_open,
    circuitOpen: result.circuit_open,
    infraCount: result.infra_count,
    retryAt: result.retry_at ?? undefined,
    generation: result.generation,
    state: result.state,
  };
}

export async function clearStepInfrastructureStateStep(
  planId: string,
  stepId: string,
  eventId: string,
  expectedGeneration = 0,
): Promise<{
  cleared: boolean;
  state: string;
  generation?: number;
}> {
  'use step';
  const result = await clearPlanStepInfrastructureState({
    planId,
    stepId,
    eventId,
    expectedGeneration,
  });
  return result;
}

export async function blockRequirementForInfrastructureCircuitStep(params: {
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
  'use step';
  return blockRequirementForInfrastructureCircuit(params);
}

export async function blockRequirementForCronInfrastructureCyclesStep(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  cycleId: string;
  minimumFailures: number;
  message: string;
  expectedExecutionGeneration: number;
}): Promise<boolean> {
  'use step';
  const result = await blockRequirementForCronInfrastructureCycles(params);
  return result.blocked;
}

export async function blockRequirementForProductNoProgressStep(params: {
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
}): Promise<boolean> {
  'use step';
  const result = await blockRequirementForProductNoProgress(params);
  return result.blocked;
}

export async function requestNoProgressStepAdjudicationStep(params: {
  planId: string;
  stepId: string;
  expectedGeneration: number;
  cycleId: string;
  persistedMetadata?: Record<string, unknown>;
}): Promise<{ persisted: boolean; state: string; generation?: number }> {
  'use step';
  const result = await patchPlanStepAtomically({
    planId: params.planId,
    stepId: params.stepId,
    expectedGeneration: params.expectedGeneration,
    eventId: `${params.cycleId}:${params.stepId}:no-progress-adjudication`,
    patch: {
      metadata: {
        ...(params.persistedMetadata || {}),
        no_progress_adjudication: {
          state: 'requested',
          cycle_id: params.cycleId,
          requested_at: new Date().toISOString(),
        },
      },
    },
  });
  return {
    persisted: result.persisted,
    state: result.state,
    generation: result.generation,
  };
}

export function shouldDeferNoProgressBlock(
  mutation: { persisted: boolean; state: string },
): boolean {
  return (
    mutation.persisted ||
    mutation.state === 'stale' ||
    mutation.state === 'terminal'
  );
}

export async function reconnectSandboxStep(params: {
  sandboxId: string;
  requirementId: string;
  instanceType: string;
  title: string;
  audit: CronAuditContext;
}): Promise<{ sandboxId: string }> {
  'use step';
  try {
    const connected = await connectOrRecreateRequirementSandbox({
      sandboxId: params.sandboxId,
      requirementId: params.requirementId,
      instanceType: params.instanceType,
      title: params.title,
      audit: params.audit,
    });
    
    // We only return the sandboxId since Sandbox class instances cannot be serialized across workflow steps
    return { sandboxId: connected.sandboxId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reconnectSandboxStep] failed: ${msg}`);
    throw new Error(msg);
  }
}

export async function logCronInfrastructureEventStep(
  ctx: CronAuditContext | null | undefined,
  payload: {
    event: string;
    level?: 'info' | 'warn' | 'error';
    message: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  'use step';
  await logCronInfrastructureEvent(ctx, payload);
}
