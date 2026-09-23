import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools, fetchMemoriesContext, generateAgentBackground } from '@/app/api/robots/instance/assistant/utils';
import { fetchStepLogHistoryText } from './step-history-builder';
import { SkillsService } from '@/lib/services/skills-service';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import type { GitRepoKind } from './cron-commit-helpers';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { type CronAuditContext } from '@/lib/services/cron-audit-log';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { SandboxService } from '@/lib/services/sandbox-service';
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { sandboxIdentity } from '@/lib/services/sandbox-sdk';
import {
  buildSingleTurnSystemPrompt,
  buildUntrustedHistoryMessage,
  inferRoleFromStep,
  ROLE_TO_SKILL,
} from './single-turn-prompt';
import { buildStepRetryFeedback } from './single-turn-visual-feedback';
import { extractSingleTurnBackgroundState } from './single-turn-background-task';
import type { SingleTurnResult } from './single-turn-types';
import {
  captureInteractionBaseline,
  captureWorkspaceProgressFingerprint,
  getDeclaredTestCommand,
  getStepTerminalRequest,
  hasSandboxGoneToolFailure,
  withActionLoopGuard,
  withExecuteStepNoop,
} from './single-turn-helpers';
import {
  buildSingleTurnStartMetadata,
  markVisualFeedbackDelivered,
  resolveSingleTurnBacklogItemId,
} from './single-turn-step-state';
import { CRON_INFRASTRUCTURE_PROVENANCE } from '@/lib/services/cron-infrastructure-state';
import {
  InfrastructureStateDatabaseError,
  patchPlanStepAtomically,
} from '@/lib/services/instance-plan-infrastructure-state';
import { runSingleTurnGate } from './single-turn-gate';
import { isNoProgressAdjudicationRequested } from './no-progress-adjudication';
import { runGateOnlyNoProgressAdjudication } from './no-progress-gate-adjudicator';
import { shouldResumeGateFromEvidence } from './gate-validation-cache';
import { getBacklogItem } from '@/lib/services/requirement-backlog';
import { classifyRequirementType } from '@/lib/services/requirement-flows';
import { computeApplicationBuildFingerprint } from './commit/pre-push-build-validation';
export { inferRoleFromStep } from './single-turn-prompt';
export type { SingleTurnResult };
export async function executeSingleTurnStep(params: {
  sandboxId: string;
  plan: any;
  step: any;
  requirementId: string;
  instanceId: string;
  siteId: string;
  userId?: string;
  title: string;
  gitRepoKind: GitRepoKind;
  requirementType: string;
  validateDeployment?: boolean;
  provisionedEnvKeys?: string[];
  cycleId: string;
  executionEventId: string;
  executionGeneration: number;
}): Promise<SingleTurnResult> {
  'use step';
  const { sandboxId, plan, step, requirementId, instanceId, siteId, userId, title, gitRepoKind, requirementType, validateDeployment = true, provisionedEnvKeys, cycleId, executionEventId, executionGeneration } = params;
  const audit: CronAuditContext = {
    instanceId, siteId, userId, requirementId,
    planId: plan.id, stepId: step.id,
  };
  const instanceType = gitRepoKind === 'automation' ? 'automation' : 'applications';
  let infrastructureGeneration = Number(step.infrastructure_generation || 0);
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
    return {
      ok: false,
      isDone: false,
      transient: true,
      error: msg,
      effectiveSandboxId: sandboxId,
      infrastructureGeneration,
      infrastructureWait: {
        kind: 'sandbox',
        provenance: CRON_INFRASTRUCTURE_PROVENANCE,
      },
    };
  }
  let sandbox = connected.sandbox;
  let effectiveSandboxId = connected.sandboxId;

  try {
    let persistedStep = step;
    const { data: planRow, error: planReadError } = await supabaseAdmin
      .from('instance_plans')
      .select('steps, status')
      .eq('id', plan.id)
      .maybeSingle();
    if (planReadError) {
      throw new InfrastructureStateDatabaseError(
        `Failed to load plan ${plan.id} before executing step ${step.id}`,
        planReadError,
      );
    }
    const freshStep = Array.isArray(planRow?.steps)
      ? planRow.steps.find((candidate: any) => candidate.id === step.id)
      : undefined;
    if (!freshStep) {
      return {
        ok: false,
        isDone: false,
        error: `Plan step ${step.id} is missing`,
        effectiveSandboxId,
        infrastructureGeneration,
        concurrencyHalt: true,
      };
    }
    persistedStep = { ...step, ...freshStep };
    infrastructureGeneration =
      Number(persistedStep.infrastructure_generation || 0);
    if (
      freshStep.status === 'completed' ||
      freshStep.status === 'cancelled'
    ) {
      console.log(`[SingleTurn] Step ${step.order} already ${freshStep.status}.`);
      return {
        ok: true,
        isDone: true,
        effectiveSandboxId,
        infrastructureGeneration,
        concurrencyHalt: true,
        ...(freshStep.status === 'completed'
          ? { persistedTerminalStatus: 'completed' as const }
          : {}),
      };
    }
    // Baseline = first time THIS step started. Do not fall back to plan.created_at
    // (that is often hours/days old and would mark every file updated_this_cycle).
    const nowIso = new Date().toISOString();
    const cycleBaselineAt = persistedStep.started_at || nowIso;
    const interactionBaselineSha = await captureInteractionBaseline(sandbox, persistedStep);
    const effectiveBacklogItemId = await resolveSingleTurnBacklogItemId({
      instanceId,
      requirementId,
      persistedStep,
      step,
    });
    const retryFeedback = await buildStepRetryFeedback(
      persistedStep.error_message || step.error_message,
      persistedStep.metadata?.visual_feedback_image_id,
      requirementId,
    );
    const nextMetadata = buildSingleTurnStartMetadata({
      persistedMetadata: persistedStep.metadata,
      interactionBaselineSha,
      backlogItemId: effectiveBacklogItemId,
      cycleId,
      executionGeneration,
    });
    const startMutation = await patchPlanStepAtomically({
      planId: plan.id,
      stepId: step.id,
      expectedGeneration: infrastructureGeneration,
      eventId: `${executionEventId}:start`,
      patch: {
        status: 'in_progress',
        ...(persistedStep.started_at ? {} : { started_at: cycleBaselineAt }),
        metadata: nextMetadata,
      },
    });
    if (!startMutation.persisted) {
      return {
        ok: false,
        isDone: false,
        error: `Plan step start rejected (${startMutation.state})`,
        effectiveSandboxId,
        infrastructureGeneration: startMutation.generation,
        concurrencyHalt: true,
      };
    }
    infrastructureGeneration =
      startMutation.generation ?? infrastructureGeneration;
    persistedStep = {
      ...persistedStep,
      status: 'in_progress',
      metadata: nextMetadata,
      infrastructure_generation: infrastructureGeneration,
    };
    const noProgressAdjudication =
      isNoProgressAdjudicationRequested(
        persistedStep,
        executionGeneration,
      );

    const effectiveRole =
      persistedStep.role || inferRoleFromStep(persistedStep) || 'general';
    const skillName =
      persistedStep.skill || (effectiveRole && ROLE_TO_SKILL[effectiveRole]);
    let skillContext = '';
    if (skillName) {
      const matched = SkillsService.getSkillBySlugOrName(skillName);
      if (matched) skillContext = `\n\n--- SKILL INSTRUCTIONS: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`;
    }

    if (effectiveRole === 'qa') {
      skillContext += `\n\n--- QA SPECIFIC MANDATORY RULES ---\n1. ROOT CLEANUP & REPO HEALTH: You MUST always delete unnecessary files from the repository root (e.g., test.js, temp.json, dummy files) or move them to their correct locations. Maintain the repository in a pristine, professional state.\n2. NAMING & VARIABLES REVIEW: You MUST review variables, functions, and classes for clear, consistent, and descriptive English naming conventions. Rename them if they are ambiguous, misleading, or poorly named.\n--- END QA RULES ---\n`;
    }

    let progressContext = '';
    if (requirementId) {
      const { data: reqData } = await supabaseAdmin
        .from('requirements')
        .select('progress')
        .eq('id', requirementId)
        .single();
        
      if (reqData && reqData.progress && Array.isArray(reqData.progress) && reqData.progress.length > 0) {
        const recentProgress = reqData.progress.slice(-5);
        progressContext = '\n\n📋 RECENT REQUIREMENT PROGRESS:\n';
        progressContext += JSON.stringify(recentProgress, null, 2);
      }
    }

    // Get instance context for background/memories
    const agentBackground = await generateAgentBackground(siteId);
    const memoriesContext = await fetchMemoriesContext(
      siteId,
      userId,
      instanceId,
    );
    let historyContext = '';
    try {
      const userHistory = await loadUserActionHistory(instanceId, {
        requirementId,
        maxTotalBytes: 8 * 1024,
        headN: 3,
        tailN: 8,
        hardCap: 100,
        maxMessageBytes: 2 * 1024,
      });
      historyContext = `\n\n${userHistory.promptText}`;
    } catch (error: unknown) {
      console.warn(
        '[SingleTurn] Could not load requirement user history:',
        error instanceof Error ? error.message : error,
      );
    }
    const retryContext = retryFeedback.promptFragment;

    const { loadConstraintSourceBlocks } = await import('@/lib/services/requirement-constraints-persist');
    const constraintSources = requirementId ? await loadConstraintSourceBlocks(requirementId) : [];
    const systemPrompt = buildSingleTurnSystemPrompt({
      instanceId,
      siteId,
      requirementId,
      plan,
      step: persistedStep,
      effectiveRole,
      cycleBaselineAt,
      skillContext,
      progressContext,
      agentBackground,
      memoriesContext,
      historyContext,
      retryContext,
      constraintSources,
      provisionedEnvKeys,
      noProgressAdjudication,
    });

    const historyText = await fetchStepLogHistoryText(
      instanceId,
      plan.id,
      persistedStep.id,
    );
    const messages: any[] = [];
    if (historyContext) {
      messages.push({
        role: 'user' as const,
        content: buildUntrustedHistoryMessage(historyContext),
      });
    }
    messages.push({
      role: 'user' as const,
      content:
        `Execute step ${persistedStep.order}: ${persistedStep.title}. ` +
        `${persistedStep.instructions}`,
    });
    if (retryFeedback.imageMessage) messages.push(retryFeedback.imageMessage);

    if (historyText) {
      messages.push({
        role: 'user' as const,
        content: `${historyText}\n\nReview the previous actions including any gate failures. Decide the next single tool call to advance the step, or finish the step if completed. REMEMBER: MAXIMUM 1 TOOL CALL.`
      });
    }

    const activeSandboxRef = { current: sandbox };
    const sandboxTools = getSandboxTools(sandbox, requirementId, {
      site_id: siteId,
      instance_id: instanceId,
      git_repo_kind: gitRepoKind,
      requirement_type: requirementType,
      validate_deployment: validateDeployment,
      plan_id: plan.id,
      active_step_id: persistedStep.id,
      backlog_item_id: effectiveBacklogItemId || undefined,
      cycle_baseline_at: cycleBaselineAt,
      activeSandboxRef,
    });
    
    const guardedTools = withActionLoopGuard(withExecuteStepNoop(
      getAssistantTools(
        siteId,
        userId,
        instanceId,
        sandboxTools,
        undefined,
        undefined,
        requirementId,
      ),
    ), historyText);
    const fullTools = guardedTools;

    if (noProgressAdjudication) {
      return runGateOnlyNoProgressAdjudication({
        executionEventId,
        gateInput: {
          sandbox, effectiveSandboxId, plan, step: persistedStep, persistedStep,
          requirementId, instanceId, siteId, userId, requirementType,
          gitRepoKind, backlogItemId: effectiveBacklogItemId,
          interactionBaselineSha, systemPrompt, fullTools, audit,
          infrastructureGeneration, executionEventId, result: {},
        },
      });
    }

    const workspaceFingerprintBefore =
      await captureWorkspaceProgressFingerprint(sandbox);
    const flow = classifyRequirementType(requirementType);
    const validationFingerprint =
      flow === 'app' || flow === 'site'
        ? await computeApplicationBuildFingerprint(
            sandbox,
            SandboxService.WORK_DIR,
          ) || undefined
        : undefined;
    if (
      effectiveBacklogItemId &&
      validationFingerprint &&
      (flow === 'app' || flow === 'site')
    ) {
      try {
        const { item } = await getBacklogItem(
          requirementId,
          effectiveBacklogItemId,
        );
        if (shouldResumeGateFromEvidence({
          evidence: item?.evidence,
          stepId: persistedStep.id,
          workspaceFingerprint: validationFingerprint,
          testCommand: getDeclaredTestCommand(persistedStep),
        })) {
          console.log(
            `[SingleTurn] Resuming unchanged gate for step ${persistedStep.order} without another assistant turn.`,
          );
          return runSingleTurnGate({
            sandbox,
            effectiveSandboxId,
            plan,
            step: persistedStep,
            persistedStep,
            requirementId,
            instanceId,
            siteId,
            userId,
            requirementType,
            gitRepoKind,
            backlogItemId: effectiveBacklogItemId,
            interactionBaselineSha,
            systemPrompt,
            result: {},
            fullTools,
            audit,
            infrastructureGeneration,
            executionEventId,
          });
        }
      } catch (error: unknown) {
        console.warn(
          '[SingleTurn] Could not evaluate the cached gate resume:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    const result = await executeAssistantStep(messages, { id: instanceId, site_id: siteId, user_id: userId, requirement_id: requirementId }, {
      instance_id: instanceId,
      site_id: siteId,
      user_id: userId,
      requirement_id: requirementId,
      plan_id: plan.id,
      step_id: persistedStep.id,
      system_prompt: systemPrompt,
      custom_tools: fullTools,
      enforceSingleTurn: true // CRITICAL: enforce 1 tool call max per invocation
    });
    sandbox = activeSandboxRef.current;
    effectiveSandboxId = sandboxIdentity(sandbox);
    const workspaceFingerprintAfter =
      await captureWorkspaceProgressFingerprint(sandbox);
    const durableProductProgress =
      !!workspaceFingerprintBefore &&
      !!workspaceFingerprintAfter &&
      workspaceFingerprintBefore !== workspaceFingerprintAfter;
    const visualFeedbackMutation = await markVisualFeedbackDelivered({
      planId: plan.id,
      instanceId,
      siteId,
      requirementId,
      stepId: persistedStep.id,
      persistedMetadata: persistedStep.metadata,
      interactionBaselineSha,
      backlogItemId: effectiveBacklogItemId,
      imageFeedbackId: retryFeedback.imageFeedbackId,
      delivered: !!retryFeedback.imageMessage,
      expectedGeneration: infrastructureGeneration,
      eventId: `${executionEventId}:visual-feedback`,
    });
    if (visualFeedbackMutation) {
      if (!visualFeedbackMutation.persisted) {
        return {
          ok: false,
          isDone: false,
          error:
            `Visual feedback state changed concurrently (${visualFeedbackMutation.state})`,
          effectiveSandboxId,
          infrastructureGeneration: visualFeedbackMutation.generation,
          concurrencyHalt: true,
          durableProductProgress,
        };
      }
      infrastructureGeneration =
        visualFeedbackMutation.generation ?? infrastructureGeneration;
      persistedStep = {
        ...persistedStep,
        metadata: {
          ...(persistedStep.metadata || {}),
          visual_feedback_image_id: retryFeedback.imageFeedbackId,
        },
        infrastructure_generation: infrastructureGeneration,
      };
    }

    // Only failed sandbox tools can report VM loss. Business-tool payloads may
    // legitimately contain HTTP 410 values and must not open an infra circuit.
    if (hasSandboxGoneToolFailure(result)) {
      console.warn(`[SingleTurn] Sandbox gone detected. Will retry next workflow cycle.`);
      return {
        ok: false,
        isDone: false,
        transient: true,
        error: 'Sandbox Gone 410',
        effectiveSandboxId,
        infrastructureGeneration,
        durableProductProgress,
      };
    }

    const { sleepRequested, backgroundTask } = extractSingleTurnBackgroundState(result);
    const terminalRequest = getStepTerminalRequest(result, {
      planId: plan.id,
      stepId: persistedStep.id,
    });
    if (terminalRequest?.status === 'failed') {
      return {
        ok: false,
        isDone: true,
        error:
          terminalRequest.output ||
          `Executor reported failure for step ${persistedStep.order}`,
        effectiveSandboxId,
        sleepRequested,
        backgroundTask,
        infrastructureGeneration,
        durableProductProgress,
      };
    }
    const completionRequested = terminalRequest?.status === 'completed';
    const shouldRunGate = result.isDone || completionRequested;

    if (completionRequested && !result.isDone) {
      console.log(
        `[SingleTurn] Step ${persistedStep.order} requested completion through instance_plan; handing control to the gate.`,
      );
    }

    if (shouldRunGate) {
      const gateResult = await runSingleTurnGate({
        sandbox,
        effectiveSandboxId,
        plan,
        step: persistedStep,
        persistedStep,
        requirementId,
        instanceId,
        siteId,
        userId,
        requirementType,
        gitRepoKind,
        backlogItemId: effectiveBacklogItemId,
        interactionBaselineSha,
        systemPrompt,
        result,
        fullTools,
        audit, infrastructureGeneration, executionEventId,
        sleepRequested,
        backgroundTask,
      });
      return { ...gateResult, durableProductProgress };
    }
    return {
      ok: true,
      isDone: shouldRunGate,
      effectiveSandboxId,
      sleepRequested,
      backgroundTask,
      infrastructureGeneration,
      durableProductProgress,
    };
  } catch (e: any) {
    console.error('[SingleTurn] Executor wrapper failed:', e);
    return {
      ok: false,
      isDone: false,
      transient: true,
      error: e.message,
      effectiveSandboxId,
      infrastructureGeneration,
      infrastructureWait: {
        kind: isSandboxGoneError(e.message) ? 'sandbox' : 'gate',
        provenance: CRON_INFRASTRUCTURE_PROVENANCE,
      },
    };
  }
}
