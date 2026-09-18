import type { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { setItemStatus } from '@/lib/services/requirement-backlog';
import { classifyRequirementType } from '@/lib/services/requirement-flows';
import type { GitRepoKind } from './cron-commit-helpers';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
} from '@/lib/services/cron-audit-log';
import {
  InfrastructureStateDatabaseError,
  updatePlanStepStatusAtomically,
} from '@/lib/services/instance-plan-infrastructure-state';
import {
  buildGateInfrastructureWait,
  CRON_INFRASTRUCTURE_PROVENANCE,
} from '@/lib/services/cron-infrastructure-state';
import { SandboxService } from '@/lib/services/sandbox-service';
import { sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { applyGateFailureHealing } from './gate-failure-healing';
import { runArchetypePostGate } from './step-archetype-postgate';
import { runGateForFlow } from './gates';
import type { AppGateContext } from './gates/types';
import {
  buildGateErrorFeedback,
  getDeclaredProtectedRoutes,
  isTransientGateFailure,
} from './single-turn-helpers';
import type { SingleTurnResult } from './single-turn-types';

interface RunSingleTurnGateInput {
  sandbox: Sandbox;
  effectiveSandboxId: string;
  plan: any;
  step: any;
  persistedStep: any;
  requirementId: string;
  instanceId: string;
  siteId: string;
  userId?: string;
  requirementType: string;
  gitRepoKind: GitRepoKind;
  backlogItemId: string | null;
  interactionBaselineSha?: string;
  systemPrompt: string;
  result: any;
  fullTools: any;
  audit: CronAuditContext;
  infrastructureGeneration: number;
  sleepRequested?: number;
  backgroundTask?: SingleTurnResult['backgroundTask'];
}

/**
 * Runs and persists the gate phase after the one-tool assistant turn.
 * Backlog completion deliberately happens only after the final plan-step CAS.
 */
export async function runSingleTurnGate(
  input: RunSingleTurnGateInput,
): Promise<SingleTurnResult> {
  const {
    plan,
    step,
    persistedStep,
    requirementId,
    instanceId,
    siteId,
    userId,
    requirementType,
    gitRepoKind,
    backlogItemId,
    interactionBaselineSha,
    systemPrompt,
    result,
    fullTools,
    audit,
    sleepRequested,
    backgroundTask,
  } = input;
  let { sandbox, effectiveSandboxId, infrastructureGeneration } = input;
  const flow = classifyRequirementType(requirementType);

  let appContext: AppGateContext | undefined;
  if (flow === 'app' || flow === 'site' || flow === 'automation') {
    appContext = {
      planTitle: plan.title,
      stepOrder: step.order,
      backlogItemId,
      interactionBaselineSha,
      stepPrompt: systemPrompt,
      stepContext: {
        title: step.title,
        instructions: step.instructions,
        expected_output: step.expected_output,
        protected_routes: getDeclaredProtectedRoutes(step),
      },
      currentMessages: result.messages,
      assistantContext: {
        instance: {
          id: instanceId,
          site_id: siteId,
          user_id: userId,
          requirement_id: requirementId,
        },
        systemPrompt,
        customTools: fullTools,
        executionOptions: {
          instance_id: instanceId,
          site_id: siteId,
          user_id: userId,
          requirement_id: requirementId,
          plan_id: plan.id,
          step_id: step.id,
          system_prompt: systemPrompt,
          custom_tools: fullTools,
        },
      } as any,
      fullTools,
      lastResult: result,
      gitRepoKind,
    };
  }

  const gateRes = await runGateForFlow({
    flow,
    sandbox,
    workDir: SandboxService.WORK_DIR,
    requirementId,
    item: {
      id: step.id,
      title: step.title,
      order: step.order,
      acceptance: step.instructions ? [String(step.instructions)] : [],
    } as any,
    appContext,
    audit,
  });
  const gateFeedback = buildGateErrorFeedback({
    gate: gateRes,
    step,
    persistedStep,
  });
  const gateErrorExcerpt = gateFeedback.excerpt;

  if (gateRes.sandboxReplacement) {
    effectiveSandboxId = sandboxIdentity(gateRes.sandboxReplacement);
    sandbox = gateRes.sandboxReplacement;
  }

  if (isTransientGateFailure(gateRes)) {
    console.warn(
      `[SingleTurn] Gate infrastructure unavailable for step ${step.order}: ${gateRes.error || 'unknown error'}`,
    );
    return {
      ok: false,
      isDone: false,
      transient: true,
      error: gateRes.error || 'Gate infrastructure unavailable',
      effectiveSandboxId,
      infrastructureWait: buildGateInfrastructureWait({
        deploy: gateRes.vercelDeploy,
        fallbackKind: gateRes.sandboxUnavailable ? 'sandbox' : 'gate',
        requirementId,
        planId: plan.id,
        stepId: step.id,
      }),
      infrastructureGeneration,
    };
  }

  let persistedTerminalStatus: 'completed' | 'failed' | undefined;
  if (gateRes.ok) {
    console.log(`[SingleTurn] Gate PASSED for step ${step.order}`);
    const { data: latestPlan, error: latestPlanError } = await supabaseAdmin
      .from('instance_plans')
      .select('steps')
      .eq('id', plan.id)
      .maybeSingle();
    if (latestPlanError) {
      throw new InfrastructureStateDatabaseError(
        `Failed to reload plan ${plan.id} after gate`,
        latestPlanError,
      );
    }
    if (!latestPlan || !Array.isArray(latestPlan.steps)) {
      throw new Error(`Plan ${plan.id} is missing after gate`);
    }
    const isLastStep = !latestPlan.steps.some(
      (candidate: any) =>
        candidate.id !== step.id &&
        (candidate.status === 'pending' || candidate.status === 'in_progress'),
    );

    const gateBarrier = await updatePlanStepStatusAtomically({
      planId: plan.id,
      stepId: step.id,
      status: 'in_progress',
      expectedGeneration: infrastructureGeneration,
    });
    if (!gateBarrier.persisted) {
      return {
        ok: false,
        isDone: false,
        error: `Post-gate state check rejected (${gateBarrier.state})`,
        effectiveSandboxId,
        infrastructureGeneration: gateBarrier.generation,
        concurrencyHalt: true,
      };
    }
    infrastructureGeneration =
      gateBarrier.generation ?? infrastructureGeneration;

    if (isLastStep && backlogItemId) {
      console.log(
        `[SingleTurn] Step ${step.order} is final. Running Post-Gate Archetypes (Critic/Judge)...`,
      );
      const postGate = await runArchetypePostGate({
        sandbox,
        requirementId,
        backlogItemId,
        stepId: step.id,
        signals: gateRes.richSignals as any,
        capturedAt: new Date().toISOString(),
        audit,
      });
      if (!postGate.ran) {
        return {
          ok: false,
          isDone: false,
          transient: true,
          error: postGate.error || 'Post-gate evaluation was unavailable.',
          effectiveSandboxId,
          infrastructureGeneration,
          infrastructureWait: {
            kind: 'gate',
            provenance: CRON_INFRASTRUCTURE_PROVENANCE,
          },
        };
      }
      if (postGate.judge_verdict !== 'approved') {
        return {
          ok: true,
          isDone: false,
          effectiveSandboxId,
          gatePassed: false,
          gateErrorExcerpt:
            `Post-gate judge returned ${postGate.judge_verdict}.`,
          sleepRequested,
          backgroundTask,
          remediationScheduled: true,
          infrastructureGeneration,
        };
      }
    }

    const completionMutation = await updatePlanStepStatusAtomically({
      planId: plan.id,
      stepId: step.id,
      status: 'completed',
      expectedGeneration: infrastructureGeneration,
    });
    if (!completionMutation.persisted) {
      return {
        ok: false,
        isDone: false,
        error: `Step completion rejected (${completionMutation.state})`,
        effectiveSandboxId,
        infrastructureGeneration: completionMutation.generation,
        concurrencyHalt: true,
      };
    }
    infrastructureGeneration =
      completionMutation.generation ?? infrastructureGeneration;
    persistedTerminalStatus = 'completed';

    if (isLastStep && backlogItemId) {
      try {
        await setItemStatus({
          requirementId,
          itemId: backlogItemId,
          status: 'done',
        });
      } catch (error: unknown) {
        return {
          ok: false,
          isDone: false,
          transient: true,
          error:
            `Plan step completed but backlog finalization failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          effectiveSandboxId,
          infrastructureGeneration,
          infrastructureWait: {
            kind: 'gate',
            provenance: CRON_INFRASTRUCTURE_PROVENANCE,
          },
        };
      }
    }
  } else {
    console.log(`[SingleTurn] Gate FAILED for step ${step.order}`);
    const failureMutation = await updatePlanStepStatusAtomically({
      planId: plan.id,
      stepId: step.id,
      status: gateRes.remediationScheduled ? 'in_progress' : 'failed',
      errorMessage: gateErrorExcerpt,
      expectedGeneration: infrastructureGeneration,
    });
    if (!failureMutation.persisted) {
      return {
        ok: false,
        isDone: false,
        error: `Step failure rejected (${failureMutation.state})`,
        effectiveSandboxId,
        infrastructureGeneration: failureMutation.generation,
        concurrencyHalt: true,
      };
    }
    infrastructureGeneration =
      failureMutation.generation ?? infrastructureGeneration;
    if (!gateRes.remediationScheduled) {
      persistedTerminalStatus = 'failed';
    }
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.STEP_STATUS,
      level: 'warn',
      message: `Plan step ${step.order} failed gate validation`,
      details: {
        step_id: step.id,
        plan_id: plan.id,
        error_excerpt: gateErrorExcerpt.slice(0, 500),
        gate_signals: gateRes.signals,
      },
    });

    if (backlogItemId) {
      try {
        await applyGateFailureHealing({
          requirementId,
          backlogItemId,
          error: gateFeedback.raw,
          categories: gateFeedback.categories,
          flow: requirementType,
          signals: gateRes.signals,
          skipAttemptBump: gateRes.skipAttemptBump,
          remediationScheduled: gateRes.remediationScheduled,
          logPrefix: '[SingleTurn]',
        });
      } catch (error) {
        console.error(
          '[SingleTurn] Exception applying self-healing on gate failure:',
          error,
        );
      }
    }
  }

  return {
    ok: true,
    isDone: !gateRes.remediationScheduled,
    effectiveSandboxId,
    gatePassed: gateRes.ok,
    gateErrorExcerpt,
    sleepRequested,
    backgroundTask,
    remediationScheduled: gateRes.remediationScheduled,
    infrastructureGeneration,
    ...(persistedTerminalStatus ? { persistedTerminalStatus } : {}),
  };
}
