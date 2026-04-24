'use step';
/**
 * Pending/failed plan step execution loop + post-plan smoke test (cron sandbox).
 */

import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import type { AssistantContext } from '@/app/api/robots/instance/assistant/steps';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { inlineExecutePlanStep, runSmokeTest } from './inline-step-executor';
import { classifyRequirementType } from '@/lib/services/requirement-flows';
import { checkpointPlanIteration } from './cron-commit-helpers';
import { runOrchestratorStep } from './cron-orchestrator-step';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';

/** Orchestrator passes after executor exhausts gate retries — instance_plan rewrite before final step failure */
const MAX_PLAN_ADAPTATION_ORCHESTRATOR_PASSES = 2;

/** Reprovision + re-run the same plan step when the microVM returns 410 Gone mid-gate (not a code failure). */
const MAX_SANDBOX_GONE_MID_STEP = 4;

function buildPlanAdaptationUserMessage(
  planTitle: string,
  reqId: string,
  planId: string,
  step: { id: string; order: number; title?: string },
  gateError: string,
): string {
  return [
    `PLAN ADAPTATION REQUIRED — the executor failed all automated gate retries (build / origin).`,
    `Requirement context: "${planTitle}" — requirement_id=${reqId}`,
    `You must use the same plan: plan_id=${planId} and the correct instance_id when calling instance_plan.`,
    ``,
    `Failed step: order=${step.order}, step_id=${step.id}, title=${(step.title || '').slice(0, 240)}`,
    ``,
    `Gate / build / origin error (fix the plan so the next executor run can succeed):`,
    `---`,
    gateError.slice(0, 12000),
    `---`,
    ``,
    `Use instance_plan (list / update steps, or replace the plan if necessary) to adapt: clearer instructions, split work, add a recovery step, fix paths (src/app/…), or reorder dependencies.`,
    `Do not implement code yourself here — only update the plan. The workflow will run the executor again on the updated pending step.`,
  ].join('\n');
}

/** Why the step loop stopped without a step-level failure */
export type PlanExecutionHaltReason = 'missing' | 'paused' | 'cancelled' | 'terminal';

type PlanGate =
  | { runnable: true; dbStatus: string }
  | { runnable: false; reason: PlanExecutionHaltReason };

function getPlanExecutionGateFromStatus(status: string | undefined | null): PlanGate {
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

async function getPlanExecutionGate(planId: string): Promise<PlanGate> {
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

/** Result of running pending/failed plan steps in the cron sandbox */
export type ExecuteStepsPhaseResult = {
  executed: number;
  smokeError: string | null;
  anyStepFailed: boolean;
  /** Last step id touched in the loop (for post-finally error attribution) */
  lastTouchedStepId: string | null;
  /** True when the plan was paused, cancelled, deleted, or became terminal mid-run */
  planExecutionHalted?: boolean;
  haltReason?: PlanExecutionHaltReason;
  /** Current sandbox id (new VM if the previous one was reprovisioned) */
  effectiveSandboxId: string;
};

export async function executeStepsPhaseStep(params: {
  sandboxId: string;
  title: string;
  reqId: string;
  requirementType: string;
  orchestratorPrompt: string;
  instanceId: string;
  site_id: string;
  user_id: string;
  planId: string;
  planStatus: string;
  steps: any[];
  git_repo_kind?: 'applications' | 'automation';
}): Promise<ExecuteStepsPhaseResult> {
  'use step';
  const {
    sandboxId,
    title,
    reqId,
    requirementType,
    orchestratorPrompt,
    instanceId,
    site_id,
    user_id,
    planId,
    planStatus: _planStatus,
    steps: allSteps,
    git_repo_kind = 'applications',
  } = params;

  const haltAudit: CronAuditContext = {
    instanceId: instanceId,
    siteId: site_id,
    userId: user_id,
    requirementId: reqId,
  };

  let effectiveSandboxId = sandboxId;
  const instanceType = git_repo_kind === 'automation' ? 'automation' : 'applications';

  const pending = allSteps
    .filter((s) => s.status === 'pending' || s.status === 'in_progress')
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const retries = allSteps.filter((s) => s.status === 'failed' && (s.retry_count ?? 0) < 2);
  const stepsToRun = [...retries, ...pending];

  if (stepsToRun.length === 0) {
    return {
      executed: 0,
      smokeError: null,
      anyStepFailed: false,
      lastTouchedStepId: null,
      effectiveSandboxId,
    };
  }

  const initialGate = await getPlanExecutionGate(planId);
  if (!initialGate.runnable) {
    console.log(
      `[CronStep] Plan execution halted before steps (plan_id=${planId} reason=${initialGate.reason})`,
    );
    await logCronInfrastructureEvent(haltAudit, {
      event: CronInfraEvent.PLAN_EXECUTION_HALTED,
      level: 'warn',
      message: `Plan step loop skipped — ${initialGate.reason} (plan_id=${planId})`,
      details: { plan_id: planId, halt_reason: initialGate.reason },
    });
    return {
      executed: 0,
      smokeError: null,
      anyStepFailed: false,
      lastTouchedStepId: null,
      planExecutionHalted: true,
      haltReason: initialGate.reason,
      effectiveSandboxId,
    };
  }

  if (initialGate.dbStatus === 'pending') {
    await supabaseAdmin
      .from('instance_plans')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', planId);
  }

  let connected: Awaited<ReturnType<typeof connectOrRecreateRequirementSandbox>>;
  try {
    connected = await connectOrRecreateRequirementSandbox({
      sandboxId: effectiveSandboxId,
      requirementId: reqId,
      instanceType,
      title,
      audit: haltAudit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CronStep] Initial sandbox connect failed: ${msg}`);
    await logCronInfrastructureEvent(haltAudit, {
      event: CronInfraEvent.STEP_STATUS,
      level: 'error',
      message: `executeStepsPhaseStep: sandbox connect failed — ${msg.slice(0, 400)}`,
      details: { plan_id: planId, error: msg.slice(0, 2000) },
    }).catch(() => {});
    return {
      executed: 0,
      smokeError: msg,
      anyStepFailed: true,
      lastTouchedStepId: null,
      effectiveSandboxId,
    };
  }
  let sandbox = connected.sandbox;
  effectiveSandboxId = connected.sandboxId;

  try {
    await sandbox.extendTimeout(10 * 60 * 1000);
  } catch {
    /* plan limits may reject */
  }

  let executed = 0;
  let anyStepFailed = false;
  let lastTouchedStepId: string | null = null;
  let planExecutionHalted = false;
  let haltReason: PlanExecutionHaltReason | undefined;

  let workingPlanSteps: any[] = [...allSteps];
  const startTime = Date.now();
  const MAX_EXECUTION_TIME_MS = 4 * 60 * 1000; // 4 minutes

  try {
    outer: for (const planStep of stepsToRun) {
      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        console.log(`[CronStep] Reached max execution time (${MAX_EXECUTION_TIME_MS}ms). Halting step loop to prevent Vercel timeout.`);
        break outer;
      }

      const gateOuter = await getPlanExecutionGate(planId);
      if (!gateOuter.runnable) {
        planExecutionHalted = true;
        haltReason = gateOuter.reason;
        console.log(
          `[CronStep] Plan execution halted between steps (plan_id=${planId} reason=${gateOuter.reason})`,
        );
        await logCronInfrastructureEvent(haltAudit, {
          event: CronInfraEvent.PLAN_EXECUTION_HALTED,
          level: 'warn',
          message: `Plan step loop stopped between steps — ${gateOuter.reason}`,
          details: { plan_id: planId, halt_reason: gateOuter.reason },
        });
        break outer;
      }

      let reconnect: Awaited<ReturnType<typeof connectOrRecreateRequirementSandbox>>;
      try {
        reconnect = await connectOrRecreateRequirementSandbox({
          sandboxId: effectiveSandboxId,
          requirementId: reqId,
          instanceType,
          title,
          audit: haltAudit,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[CronStep] Sandbox reconnect failed between steps: ${msg}`);
        await logCronInfrastructureEvent(haltAudit, {
          event: CronInfraEvent.STEP_STATUS,
          level: 'error',
          message: `executeStepsPhaseStep: sandbox reconnect failed — ${msg.slice(0, 400)}`,
          details: { plan_id: planId, error: msg.slice(0, 2000) },
        }).catch(() => {});
        anyStepFailed = true;
        break outer;
      }
      sandbox = reconnect.sandbox;
      effectiveSandboxId = reconnect.sandboxId;

    const needsRetryCountBump = planStep.status === 'failed';
    let didRetryCountBump = false;
    let workingStep: any = planStep;
    let orchestratorPassesUsed = 0;

    adapt_loop: while (true) {
      const gateInner = await getPlanExecutionGate(planId);
      if (!gateInner.runnable) {
        planExecutionHalted = true;
        haltReason = gateInner.reason;
        console.log(
          `[CronStep] Plan execution halted during step (plan_id=${planId} reason=${gateInner.reason})`,
        );
        await logCronInfrastructureEvent(haltAudit, {
          event: CronInfraEvent.PLAN_EXECUTION_HALTED,
          level: 'warn',
          message: `Plan step loop stopped mid-step — ${gateInner.reason}`,
          details: { plan_id: planId, halt_reason: gateInner.reason },
        });
        break outer;
      }

      lastTouchedStepId = workingStep.id;

      const sandboxActiveRef = { current: sandbox };
      const sandboxTools = getSandboxTools(sandbox, reqId, {
        site_id,
        instance_id: instanceId,
        git_repo_kind,
        requirement_type: requirementType,
        plan_id: planId,
        active_step_id: workingStep.id,
        activeSandboxRef: sandboxActiveRef,
      });

      const stepContext: AssistantContext = {
        instance: { id: instanceId, site_id, user_id, requirement_id: reqId },
        systemPrompt: orchestratorPrompt,
        customTools: [...sandboxTools],
        executionOptions: {
          use_sdk_tools: false,
          provider: 'openai',
          instance_id: instanceId,
          site_id,
          user_id,
          // Sandbox code assistant: prefer the customtools Gemini variant unless AI_CODE_MODEL overrides it.
          // ai_provider falls back to env AI_PROVIDER (default 'gemini').
          ai_model: process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools',
        },
        initialMessage: 'Execute plan steps',
        imageAssets: [],
        hasLinkedRequirement: true,
        expectedResultsAmount: 0,
      };

      try {
        if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
          console.log(`[CronStep] Reached max execution time (${MAX_EXECUTION_TIME_MS}ms) before starting inline step execution. Halting step loop to prevent Vercel timeout.`);
          break outer;
        }
        if (needsRetryCountBump && !didRetryCountBump) {
          didRetryCountBump = true;
          console.log(`[CronStep] → Step ${workingStep.order}: ${workingStep.title} (RETRY from failed)`);
          await updateInstancePlanCore({
            plan_id: planId,
            instance_id: instanceId,
            site_id,
            steps: [{ id: workingStep.id, status: 'pending', retry_count: (workingStep.retry_count ?? 0) + 1 }],
          });
        } else if (orchestratorPassesUsed === 0) {
          console.log(`[CronStep] → Step ${workingStep.order}: ${workingStep.title}`);
        }

        const audit: CronAuditContext = {
          instanceId: instanceId,
          siteId: site_id,
          userId: user_id,
          requirementId: reqId,
        };

        let stepResult: Awaited<ReturnType<typeof inlineExecutePlanStep>>;
        let sandboxGoneAttempts = 0;
        for (;;) {
          stepResult = await inlineExecutePlanStep(
            stepContext,
            { id: planId, steps: workingPlanSteps, title },
            workingStep,
            sandbox,
            {
              gitRepoKind: git_repo_kind,
              flow: classifyRequirementType(requirementType),
              sandboxActiveRef,
            },
          );
          sandbox = sandboxActiveRef.current;
          effectiveSandboxId = sandbox.sandboxId;

          const sandboxGone =
            !stepResult.ok &&
            'sandboxUnavailable' in stepResult &&
            stepResult.sandboxUnavailable === true;

          if (!sandboxGone) break;

          sandboxGoneAttempts++;
          if (sandboxGoneAttempts > MAX_SANDBOX_GONE_MID_STEP) {
            console.error(
              `[CronStep] Sandbox still unavailable for step ${workingStep.order} after ${MAX_SANDBOX_GONE_MID_STEP} reprovision attempt(s)`,
            );
            await logCronInfrastructureEvent(audit, {
              event: CronInfraEvent.STEP_STATUS,
              level: 'error',
              message: `executeStepsPhaseStep: sandbox unavailable after ${MAX_SANDBOX_GONE_MID_STEP} reprovisions — will retry next cycle`,
              details: {
                plan_id: planId,
                step_id: workingStep.id,
                step_order: workingStep.order,
                gate_error_excerpt: stepResult.gateError.slice(0, 800),
              },
            });
            anyStepFailed = true;
            break outer;
          }

          console.warn(
            `[CronStep] Sandbox gone during step ${workingStep.order} — reprovision ${sandboxGoneAttempts}/${MAX_SANDBOX_GONE_MID_STEP}`,
          );
          await logCronInfrastructureEvent(audit, {
            event: CronInfraEvent.SANDBOX_REPROVISIONED,
            level: 'warn',
            message: `Mid-step reprovision after sandbox unavailable (attempt ${sandboxGoneAttempts}/${MAX_SANDBOX_GONE_MID_STEP})`,
            details: {
              plan_id: planId,
              step_id: workingStep.id,
              step_order: workingStep.order,
              reason: 'sandbox_unavailable_mid_gate',
            },
          });

          try {
            const re = await connectOrRecreateRequirementSandbox({
              sandboxId: effectiveSandboxId,
              requirementId: reqId,
              instanceType,
              title,
              audit: haltAudit,
            });
            sandbox = re.sandbox;
            effectiveSandboxId = re.sandboxId;
            sandboxActiveRef.current = sandbox;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[CronStep] Mid-step reprovision failed: ${msg}`);
            await logCronInfrastructureEvent(audit, {
              event: CronInfraEvent.STEP_STATUS,
              level: 'error',
              message: `executeStepsPhaseStep: mid-step reconnect failed — ${msg.slice(0, 400)}`,
              details: { plan_id: planId, error: msg.slice(0, 2000) },
            }).catch(() => {});
            anyStepFailed = true;
            break outer;
          }
        }

        if (stepResult.ok) {
          console.log(`[CronStep] ✓ Step ${workingStep.order} passed`);
          executed++;
          await checkpointPlanIteration(sandbox, title, reqId, workingStep, 'success', audit, {
            gitRepoKind: git_repo_kind,
          });
          continue outer;
        }

        const gateError = stepResult.gateError;

        // Check if the step failed due to a timeout
        if (gateError && gateError.includes('Execution time limit reached')) {
          console.log(`[CronStep] Step ${workingStep.order} paused due to time limit. Halting step loop to prevent Vercel timeout.`);
          break outer;
        }

        if (orchestratorPassesUsed < MAX_PLAN_ADAPTATION_ORCHESTRATOR_PASSES) {
          orchestratorPassesUsed++;
          console.log(
            `[CronStep] Step ${workingStep.order} gate failed — running plan adaptation orchestrator (${orchestratorPassesUsed}/${MAX_PLAN_ADAPTATION_ORCHESTRATOR_PASSES})`,
          );
          const orchOut = await runOrchestratorStep({
            sandboxId: effectiveSandboxId,
            reqId,
            requirementType,
            orchestratorPrompt,
            instanceId,
            site_id,
            user_id,
            initialMessage: buildPlanAdaptationUserMessage(title, reqId, planId, workingStep, gateError),
            git_repo_kind,
            requirementTitle: title,
          });
          effectiveSandboxId = orchOut.effectiveSandboxId;
          let afterOrch: Awaited<ReturnType<typeof connectOrRecreateRequirementSandbox>>;
          try {
            afterOrch = await connectOrRecreateRequirementSandbox({
              sandboxId: effectiveSandboxId,
              requirementId: reqId,
              instanceType,
              title,
              audit: haltAudit,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[CronStep] Sandbox reconnect after orchestrator failed: ${msg}`);
            await logCronInfrastructureEvent(audit, {
              event: CronInfraEvent.STEP_STATUS,
              level: 'error',
              message: `executeStepsPhaseStep: post-adaptation reconnect failed — ${msg.slice(0, 400)}`,
              details: { plan_id: planId, error: msg.slice(0, 2000) },
            }).catch(() => {});
            anyStepFailed = true;
            break outer;
          }
          sandbox = afterOrch.sandbox;
          effectiveSandboxId = afterOrch.sandboxId;
          await logCronInfrastructureEvent(audit, {
            event: CronInfraEvent.PLAN_ADAPTATION,
            message: `instance_plan adaptation orchestrator finished after step ${workingStep.order} gate failure (pass ${orchestratorPassesUsed})`,
            details: {
              plan_id: planId,
              step_id: workingStep.id,
              step_order: workingStep.order,
              orchestrator_pass: orchestratorPassesUsed,
              gate_error_excerpt: gateError.slice(0, 600),
            },
          });

          const { data: planRow } = await supabaseAdmin
            .from('instance_plans')
            .select('steps, status')
            .eq('id', planId)
            .maybeSingle();
          const adaptGate = getPlanExecutionGateFromStatus(planRow?.status);
          if (!adaptGate.runnable) {
            planExecutionHalted = true;
            haltReason = adaptGate.reason;
            await logCronInfrastructureEvent(audit, {
              event: CronInfraEvent.PLAN_EXECUTION_HALTED,
              level: 'warn',
              message: `Plan step loop stopped after adaptation — ${adaptGate.reason}`,
              details: { plan_id: planId, halt_reason: adaptGate.reason },
            });
            break outer;
          }
          const freshSteps = (planRow?.steps as any[]) || [];
          workingPlanSteps = [...freshSteps];

          const refreshed = freshSteps.find((s: any) => s.id === workingStep.id);
          if (refreshed) {
            workingStep = refreshed;
          } else {
            console.error(`[CronStep] Step ${workingStep.id} missing from plan after adaptation — aborting phase`);
            anyStepFailed = true;
            break outer;
          }

          continue adapt_loop;
        }

        console.log(
          `[CronStep] ✗ Step ${workingStep.order} still failing after ${MAX_PLAN_ADAPTATION_ORCHESTRATOR_PASSES} adaptation pass(es) — stopping plan run`,
        );
        anyStepFailed = true;
        break outer;
      } catch (err: any) {
        console.error(`[CronStep] ✗ Step ${workingStep.order} failed: ${err?.message}`);
        anyStepFailed = true;
        break outer;
      }
    }
  }
  } catch (criticalErr) {
    console.error(`[CronStep] 🚨 CRITICAL ERROR in executeStepsPhaseStep loop:`, criticalErr);
    anyStepFailed = true;
    // We do NOT stop the sandbox here. We just ensure the error is caught so we can return
    // the `effectiveSandboxId` to the outer workflow, which will stop it in its `finally` block.
  }

  let smokeError: string | null = null;
  if (executed > 0 && !anyStepFailed && !planExecutionHalted) {
    console.log('[CronStep] Running post-plan smoke test...');
    const smokeAudit: CronAuditContext = {
      instanceId: instanceId,
      siteId: site_id,
      userId: user_id,
      requirementId: reqId,
    };
    try {
      smokeError = await runSmokeTest(sandbox);
    } catch (smokeErr: unknown) {
      const msg = smokeErr instanceof Error ? smokeErr.message : String(smokeErr);
      smokeError = `Smoke test error: ${msg}`;
      console.error(`[CronStep] Smoke test threw: ${msg}`);
    }
    if (smokeError) {
      console.error(`[CronStep] Smoke test failed: ${smokeError}`);
      await logCronInfrastructureEvent(smokeAudit, {
        event: CronInfraEvent.SMOKE_TEST,
        level: 'error',
        message: `Post-plan smoke test failed: ${smokeError.slice(0, 400)}`,
        details: { error: smokeError.slice(0, 1200) },
      });
    } else {
      console.log('[CronStep] Smoke test passed');
      await logCronInfrastructureEvent(smokeAudit, {
        event: CronInfraEvent.SMOKE_TEST,
        message: 'Post-plan smoke test passed (root HTTP 200)',
        details: { ok: true },
      });
    }
  }

  return {
    executed,
    smokeError,
    anyStepFailed,
    lastTouchedStepId,
    effectiveSandboxId,
    ...(planExecutionHalted && haltReason !== undefined
      ? { planExecutionHalted: true as const, haltReason }
      : {}),
  };
}

/** Phase runs sandbox + LLM work; allow more than Workflow default (3) retries for cold VM / API flakes. */
(executeStepsPhaseStep as typeof executeStepsPhaseStep & { maxRetries?: number }).maxRetries = 10;
