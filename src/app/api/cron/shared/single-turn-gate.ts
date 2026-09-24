import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  setItemStatus,
} from '@/lib/services/requirement-backlog';
import { classifyRequirementType } from '@/lib/services/requirement-flows';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
} from '@/lib/services/cron-audit-log';
import {
  completePlanStepAfterGateAtomically,
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
import { isStrictFinalPlanStep } from '@/lib/helpers/plan-status';
import { runGateForFlow } from './gates';
import type { AppGateContext } from './gates/types';
import {
  buildGateErrorFeedback,
  getDeclaredProtectedRoutes,
  getDeclaredTestCommand,
  getDeclaredValidationTargets,
  isTransientGateFailure,
} from './single-turn-helpers';
import type { SingleTurnResult } from './single-turn-types';
import { persistJudgeRejection } from './single-turn-judge-rejection';
import { adjudicationContractAcceptance } from './single-turn-judge-contract';
import { selectReusableGateValidation } from './gate-validation-cache';
import { computeApplicationBuildFingerprint } from './commit/pre-push-build-validation';
import {
  prepareSingleTurnGateEvidence,
} from './single-turn-gate-evidence';
import type { RunSingleTurnGateInput } from './single-turn-gate-types';
import { loadBacklogGateContext } from './single-turn-gate-context';

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
    validateDeployment = true,
    backlogItemId,
    interactionBaselineSha,
    systemPrompt,
    result,
    fullTools,
    audit,
    executionEventId,
    sleepRequested,
    backgroundTask,
    requireContractJudge = false,
  } = input;
  let { sandbox, effectiveSandboxId, infrastructureGeneration } = input;
  const flow = classifyRequirementType(requirementType);
  const hasPlanSnapshot =
    Array.isArray(plan.steps) && plan.steps.length > 0;
  const validationScope: 'intermediate' | 'final' =
    !requireContractJudge &&
    hasPlanSnapshot &&
    !isStrictFinalPlanStep(plan.steps, step.id)
      ? 'intermediate'
      : 'final';
  const backlogContext = await loadBacklogGateContext(
    requirementId,
    backlogItemId,
  );
  const backlogAcceptance = backlogContext.acceptance;
  const backlogAcceptanceContract = backlogContext.acceptanceContract;
  const backlogEvidence = backlogContext.evidence;

  const testCommand = getDeclaredTestCommand(step);
  const workspaceFingerprint =
    flow === 'app' || flow === 'site'
      ? await computeApplicationBuildFingerprint(
          sandbox,
          SandboxService.WORK_DIR,
        ) || undefined
      : undefined;
  const reusableValidation = selectReusableGateValidation({
    evidence: backlogEvidence,
    stepId: step.id,
    workspaceFingerprint,
    testCommand,
  });

  let appContext: AppGateContext | undefined;
  if (flow === 'app' || flow === 'site' || flow === 'automation') {
    appContext = {
      planTitle: plan.title,
      stepId: step.id,
      stepOrder: step.order,
      validationScope,
      validateDeployment,
      backlogItemId,
      interactionBaselineSha,
      workspaceFingerprint,
      reusableValidation,
      stepPrompt: systemPrompt,
      stepContext: {
        title: step.title,
        instructions: step.instructions,
        expected_output: step.expected_output,
        protected_routes: getDeclaredProtectedRoutes(step),
        validation_targets: getDeclaredValidationTargets(step),
        acceptance: backlogAcceptance,
        acceptance_contract: backlogAcceptanceContract,
        test_command: testCommand,
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
      id: backlogItemId || step.id,
      title: step.title,
      order: step.order,
      acceptance:
        backlogAcceptance ||
        (step.instructions ? [String(step.instructions)] : []),
      acceptance_contract: backlogAcceptanceContract,
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
  const validatedFingerprint =
    gateRes.richSignals?.workspace_fingerprint || workspaceFingerprint;
  const transientGateFailure = isTransientGateFailure(gateRes);
  const preparedEvidence = await prepareSingleTurnGateEvidence({
    sandbox,
    cwd: SandboxService.WORK_DIR,
    requirementId,
    backlogItemId,
    stepId: step.id,
    persistedErrorMessage: persistedStep.error_message,
    result,
    backlogEvidence,
    workspaceFingerprint,
    validatedFingerprint,
    gateTests: gateRes.richSignals?.tests?.tests,
    gateBuild: gateRes.richSignals?.build,
    gateObservations: gateRes.richSignals?.observations,
    transientGateFailure,
  });
  const {
    tests,
    observations,
    scenarioAssertions,
    evidenceRunId,
  } = preparedEvidence;

  if (gateRes.sandboxReplacement) {
    effectiveSandboxId = sandboxIdentity(gateRes.sandboxReplacement);
    sandbox = gateRes.sandboxReplacement;
  }

  if (transientGateFailure) {
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
  let judgeAdjudicated = false;
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
    const isLastStep = isStrictFinalPlanStep(
      latestPlan.steps,
      step.id,
    );
    if (isLastStep && validationScope === 'intermediate') {
      return {
        ok: false,
        isDone: false,
        error:
          'Step became final while a lightweight gate was running; retry with the full final gate',
        effectiveSandboxId,
        infrastructureGeneration,
        concurrencyHalt: true,
      };
    }
    if ((isLastStep || requireContractJudge) && !backlogItemId) {
      return {
        ok: false,
        isDone: true,
        error:
          `Plan step ${step.id} has no backlog_item_id; Judge execution is mandatory before completion.`,
        effectiveSandboxId,
        infrastructureGeneration,
      };
    }

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

    let finalGateApproved = false;
    if ((isLastStep || requireContractJudge) && backlogItemId) {
      console.log(
        `[SingleTurn] Running Post-Gate Archetypes (Critic/Judge) for step ${step.order}.`,
      );
      const contractAcceptance = adjudicationContractAcceptance({
        step,
        requireContractJudge,
        isLastStep,
      });
      const postGate = await runArchetypePostGate({
        sandbox,
        requirementId,
        backlogItemId,
        stepId: step.id,
        signals: {
          ...(gateRes.richSignals as any),
          ...(tests.length > 0
            ? {
                tests: {
                  ok: tests.every(
                    (test) => test.exit_code === 0 && test.ran_after_changes,
                  ),
                  tests,
                },
              }
            : {}),
          ...(scenarioAssertions.length > 0
            ? {
                scenario_assertions: scenarioAssertions,
              }
            : {}),
          observations,
        },
        capturedAt: new Date().toISOString(),
        evidenceRunId,
        audit,
        ...(contractAcceptance
          ? { contractAcceptance }
          : {}),
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
        return persistJudgeRejection({
          planId: plan.id,
          stepId: step.id,
          postGate,
          effectiveSandboxId,
          infrastructureGeneration,
          executionEventId,
          sleepRequested,
          backgroundTask,
        });
      }
      judgeAdjudicated = true;
      finalGateApproved = true;
    }

    const completionMutation = await completePlanStepAfterGateAtomically({
      planId: plan.id,
      stepId: step.id,
      expectedGeneration: infrastructureGeneration,
      finalGateApproved,
    });
    if (!completionMutation.persisted) {
      return {
        ok: false,
        isDone: false,
        error: completionMutation.state === 'guarded'
          ? 'Step became final concurrently and requires a fresh final Judge pass'
          : `Step completion rejected (${completionMutation.state})`,
        effectiveSandboxId,
        infrastructureGeneration: completionMutation.generation,
        concurrencyHalt: true,
      };
    }
    infrastructureGeneration =
      completionMutation.generation ?? infrastructureGeneration;
    persistedTerminalStatus = 'completed';

    if (completionMutation.final && backlogItemId) {
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
    const missingPrecondition =
      gateRes.failureKind === 'missing_precondition';
    const failureMutation = await updatePlanStepStatusAtomically({
      planId: plan.id,
      stepId: step.id,
      status:
        gateRes.remediationScheduled || missingPrecondition
          ? 'in_progress'
          : 'failed',
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
    if (!gateRes.remediationScheduled && !missingPrecondition) {
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
          failureKind: gateRes.failureKind,
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
    ...(gateRes.ok ? {} : { gateFailureKind: gateRes.failureKind }),
    ...(persistedTerminalStatus ? { persistedTerminalStatus } : {}),
    ...(judgeAdjudicated ? { judgeAdjudicated: true } : {}),
  };
}
