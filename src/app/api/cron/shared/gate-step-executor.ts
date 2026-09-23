import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { runGateForFlow } from './gates';
import { runArchetypePostGate } from './step-archetype-postgate';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { SandboxService } from '@/lib/services/sandbox-service';
import { sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { deriveCategoriesFailed } from './step-iteration-signals';
import { applyGateFailureHealing } from './gate-failure-healing';
import { isStrictFinalPlanStep } from '@/lib/helpers/plan-status';

export interface GateStepResult {
  ok: boolean;
  passed: boolean;
  error?: string;
  gateErrorExcerpt?: string;
  effectiveSandboxId: string;
  infrastructureFailure?: boolean;
  remediationScheduled?: boolean;
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
    planId: plan.id,
    stepId: step.id,
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
      flow: requirementType as RequirementKind,
      sandbox,
      workDir: SandboxService.WORK_DIR,
      requirementId,
      item: {
        id: step.id,
        title: step.title,
        order: step.order,
        acceptance: step.instructions ? [String(step.instructions)] : [],
      } as any,
      audit,
    });

    if (gateRes.sandboxReplacement) {
      effectiveSandboxId = sandboxIdentity(gateRes.sandboxReplacement);
    }
    if (!gateRes.ok && gateRes.infrastructureFailure) {
      return {
        ok: false,
        passed: false,
        error: gateRes.error || 'Gate infrastructure unavailable',
        effectiveSandboxId,
        infrastructureFailure: true,
      };
    }

    if (gateRes.ok) {
       console.log(`[GateStep] Gate PASSED for step ${step.order}`);
       // Check if this is the last step in the plan.
       // We should only run the strict Judge evaluation if there are no more steps pending
       // for this plan, otherwise the Judge will reject the intermediate steps and burn
       // the backlog item's attempts before the plan even finishes executing.
       let isLastStep = false;
       let remainingStepsCount = 0;
       try {
         const { data: latestPlan } = await supabaseAdmin
           .from('instance_plans')
           .select('steps')
           .eq('id', plan.id)
           .single();
         
         if (latestPlan && Array.isArray(latestPlan.steps)) {
           const remainingSteps = latestPlan.steps.filter((s: any) =>
             s.id !== step.id && s.status !== 'completed'
           );
           remainingStepsCount = remainingSteps.length;
           isLastStep = isStrictFinalPlanStep(latestPlan.steps, step.id);
         } else {
           const remainingSteps = (plan?.steps || []).filter((s: any) =>
             s.id !== step.id && s.status !== 'completed'
           );
           remainingStepsCount = remainingSteps.length;
           isLastStep = isStrictFinalPlanStep(plan?.steps || [], step.id);
         }
       } catch (e) {
         console.warn(`[GateStep] Error checking isLastStep, falling back to in-memory`, e);
         const remainingSteps = (plan?.steps || []).filter((s: any) =>
           s.id !== step.id && s.status !== 'completed'
         );
         remainingStepsCount = remainingSteps.length;
         isLastStep = isStrictFinalPlanStep(plan?.steps || [], step.id);
       }

       if (!isLastStep) {
           console.log(`[GateStep] Step ${step.order} passed. Skipping Critic/Judge because there are ${remainingStepsCount} non-completed sibling steps in the plan.`);
           return { ok: true, passed: true, effectiveSandboxId };
       }

       console.log(`[GateStep] Step ${step.order} is the final step. Running Post-Gate Archetypes (Critic/Judge)...`);
       // Trigger Post-Gate Archetypes (Critic/Judge)
       const postGate = await runArchetypePostGate({
          sandbox: gateRes.sandboxReplacement || sandbox,
          requirementId,
          backlogItemId: step.metadata?.backlog_item_id || step.backlog_item_id,
          stepId: step.id,
          signals: gateRes.richSignals as any,
          capturedAt: new Date().toISOString(),
          audit,
       });
       if (!postGate.ran) {
         return {
           ok: false,
           passed: false,
           error: postGate.error || 'Post-gate evaluation was unavailable.',
           effectiveSandboxId,
           infrastructureFailure: true,
         };
       }
       if (postGate.judge_verdict !== 'approved') {
         return {
           ok: true,
           passed: false,
           gateErrorExcerpt:
             `Post-gate judge returned ${postGate.judge_verdict}.`,
           effectiveSandboxId,
         };
       }

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
            error_excerpt: (gateRes.error || gateRes.reason || '').slice(0, 500),
            gate_signals: gateRes.signals,
         }
       });

       // IMPORTANT: If the gate fails, the Judge is never reached. We must bump
       // the backlog item's attempts so the self-healing policy can eventually
       // trigger (e.g. rotate_strategy or downgrade_scope) instead of infinite loop.
       const backlogItemId = step.metadata?.backlog_item_id || step.backlog_item_id;
       if (backlogItemId) {
          try {
             const errorMsg = gateRes.error || gateRes.reason || '';
             await applyGateFailureHealing({
               requirementId,
               backlogItemId,
               error: errorMsg,
               categories: gateRes.richSignals
                 ? deriveCategoriesFailed(gateRes.richSignals as any)
                 : [],
               flow: requirementType,
               signals: gateRes.signals,
               failureKind: gateRes.failureKind,
               skipAttemptBump: gateRes.skipAttemptBump,
               remediationScheduled: gateRes.remediationScheduled,
               logPrefix: '[GateStep]',
             });
          } catch (healErr) {
             console.error(`[GateStep] Exception applying self-healing on gate failure:`, healErr);
          }
       }
       
       return {
         ok: true,
         passed: false,
         gateErrorExcerpt: gateRes.error || gateRes.reason,
         effectiveSandboxId,
         remediationScheduled: gateRes.remediationScheduled,
       };
    }
  } catch (e: any) {
    console.error(`[GateStep] Exception running gate:`, e);
    return { ok: false, passed: false, error: e.message, effectiveSandboxId };
  }
}
