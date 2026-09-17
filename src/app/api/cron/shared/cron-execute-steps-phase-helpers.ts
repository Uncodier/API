import { supabaseAdmin } from '@/lib/database/supabase-client';
import { type PlanExecutionHaltReason } from './cron-execute-steps-phase';
import { type Sandbox } from '@vercel/sandbox';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { runOrchestratorStep } from './cron-orchestrator-step';

export type PlanGate =
  | { runnable: true; dbStatus: string }
  | { runnable: false; reason: PlanExecutionHaltReason };

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

export async function getPlanExecutionGateStep(planId: string): Promise<PlanGate> {
  'use step';
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('status')
    .eq('id', planId)
    .maybeSingle();
  if (error || !data) {
    return { runnable: false, reason: 'missing' };
  }
  return getPlanExecutionGateFromStatus(data.status);
}

export async function updatePlanStepStatusStep(planId: string, stepId: string, status: string, errorMessage?: string): Promise<void> {
  'use step';
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('steps')
    .eq('id', planId)
    .single();

  if (error) throw new Error(`Failed to load plan ${planId}: ${error.message}`);
  if (!data?.steps) return;

  const steps = data.steps as any[];
  const idx = steps.findIndex((s) => s.id === stepId);
  if (idx > -1) {
    const currentStatus = steps[idx].status;
    if (
      (currentStatus === 'completed' || currentStatus === 'cancelled') &&
      currentStatus !== status
    ) {
      console.warn(
        `[CronStep] Ignoring stale step transition ${stepId}: ${currentStatus} → ${status}`,
      );
      return;
    }
    if (
      currentStatus === status &&
      (status === 'completed' || status === 'failed' || status === 'cancelled')
    ) {
      return;
    }

    steps[idx].status = status;
    if (status === 'in_progress') {
      steps[idx].started_at = steps[idx].started_at || new Date().toISOString();
    } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      steps[idx].completed_at = new Date().toISOString();
      if (status === 'failed') {
        steps[idx].retry_count = (steps[idx].retry_count || 0) + 1;
        if (errorMessage) {
          steps[idx].error_message = errorMessage;
        }
      } else if (status === 'completed') {
        steps[idx].error_message = null;
        steps[idx].infra_retry_count = 0;
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({ steps, updated_at: new Date().toISOString() })
      .eq('id', planId);
    if (updateError) {
      throw new Error(`Failed to update plan ${planId}: ${updateError.message}`);
    }
  }
}

export const MAX_INFRA_RETRIES = 4;

export async function recordStepInfraTransientStep(planId: string, stepId: string, errorMessage?: string): Promise<{ exhausted: boolean; infraCount: number }> {
  'use step';
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('steps')
    .eq('id', planId)
    .single();

  if (error) throw new Error(`Failed to load plan ${planId}: ${error.message}`);
  if (!data?.steps) return { exhausted: false, infraCount: 0 };

  const steps = data.steps as any[];
  const idx = steps.findIndex((s) => s.id === stepId);
  if (idx === -1) return { exhausted: false, infraCount: 0 };
  if (['completed', 'cancelled', 'failed'].includes(steps[idx].status)) {
    console.warn(
      `[CronStep] Ignoring stale infrastructure retry for terminal step ${stepId} (${steps[idx].status})`,
    );
    return {
      exhausted: steps[idx].status === 'failed',
      infraCount: steps[idx].infra_retry_count || 0,
    };
  }

  const infraCount = (steps[idx].infra_retry_count || 0) + 1;
  steps[idx].infra_retry_count = infraCount;

  let exhausted = false;
  if (infraCount >= MAX_INFRA_RETRIES) {
    exhausted = true;
    steps[idx].status = 'failed';
    steps[idx].completed_at = new Date().toISOString();
    steps[idx].retry_count = 2; // MAX_RETRIES to ensure it's terminally failed in reconcilePlanStep
    if (errorMessage) {
      steps[idx].error_message = `Infra limit reached (${MAX_INFRA_RETRIES}): ` + errorMessage;
    } else {
      steps[idx].error_message = `Infra limit reached (${MAX_INFRA_RETRIES})`;
    }
  }

  const { error: updateError } = await supabaseAdmin
    .from('instance_plans')
    .update({ steps, updated_at: new Date().toISOString() })
    .eq('id', planId);
  if (updateError) {
    throw new Error(`Failed to update plan ${planId}: ${updateError.message}`);
  }

  return { exhausted, infraCount };
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
