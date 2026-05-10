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

export async function updatePlanStepStatusStep(planId: string, stepId: string, status: string): Promise<void> {
  'use step';
  const { data } = await supabaseAdmin
    .from('instance_plans')
    .select('steps')
    .eq('id', planId)
    .single();

  if (!data?.steps) return;

  const steps = data.steps as any[];
  const idx = steps.findIndex((s) => s.id === stepId);
  if (idx > -1) {
    steps[idx].status = status;
    if (status === 'in_progress') {
      steps[idx].started_at = steps[idx].started_at || new Date().toISOString();
    } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      steps[idx].completed_at = new Date().toISOString();
      if (status === 'failed') {
        steps[idx].retry_count = (steps[idx].retry_count || 0) + 1;
      }
    }

    await supabaseAdmin
      .from('instance_plans')
      .update({ steps, updated_at: new Date().toISOString() })
      .eq('id', planId);
  }
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
