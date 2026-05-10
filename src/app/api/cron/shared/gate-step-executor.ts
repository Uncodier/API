import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { runGateForFlow } from './gates';
import { runArchetypePostGate } from './step-archetype-postgate';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { SandboxService } from '@/lib/services/sandbox-service';

export interface GateStepResult {
  ok: boolean;
  passed: boolean;
  error?: string;
  gateErrorExcerpt?: string;
  effectiveSandboxId: string;
}

export async function runGateStep(params: {
  sandboxId: string;
  plan: any;
  step: any;
  requirementId: string;
  instanceId: string;
  siteId: string;
  userId?: string;
  title: string;
  instanceType: string;
  requirementType: string;
}): Promise<GateStepResult> {
  'use step';
  const { sandboxId, plan, step, requirementId, instanceId, siteId, userId, title, instanceType, requirementType } = params;

  const audit: CronAuditContext = {
    instanceId: instanceId,
    siteId: siteId,
    userId: userId,
    requirementId: requirementId,
  };

  let connected;
  try {
    connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId,
      instanceType,
      title,
      audit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, passed: false, error: msg, effectiveSandboxId: sandboxId };
  }
  let sandbox = connected.sandbox;
  let effectiveSandboxId = connected.sandboxId;

  console.log(`[GateStep] Running gate for step ${step.order}`);
  try {
    const gateRes = await runGateForFlow({
      flowKind: requirementType as RequirementKind,
      sandbox,
      cwd: SandboxService.WORK_DIR,
      stepContext: { title: step.title, instructions: step.instructions, itemId: plan.metadata?.backlog_item_id },
      audit,
    });

    if (gateRes.ok) {
       console.log(`[GateStep] Gate PASSED for step ${step.order}`);
       // Trigger Post-Gate Archetypes (Critic/Judge)
       await runArchetypePostGate({
          flowKind: requirementType as RequirementKind,
          sandbox,
          requirementId,
          instanceId,
          siteId,
          userId,
          planId: plan.id,
          stepId: step.id,
          audit,
          gateSignals: gateRes.signals,
       });

       return { ok: true, passed: true, effectiveSandboxId };
    } else {
       console.log(`[GateStep] Gate FAILED for step ${step.order}`);
       
       // Log the failed gate signal state to instance_logs so we can inject it as text to LLM in next turn
       await logCronInfrastructureEvent(audit, {
         event: CronInfraEvent.STEP_STATUS,
         level: 'warn',
         message: `Plan step ${step.order} failed gate validation`,
         details: { 
            step_id: step.id, 
            plan_id: plan.id,
            error_excerpt: gateRes.error.slice(0, 500),
            gate_signals: gateRes.signals,
         }
       });
       
       return { ok: true, passed: false, gateErrorExcerpt: gateRes.error, effectiveSandboxId };
    }
  } catch (e: any) {
    console.error(`[GateStep] Exception running gate:`, e);
    return { ok: false, passed: false, error: e.message, effectiveSandboxId };
  }
}
