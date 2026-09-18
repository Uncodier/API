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
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { inferRoleFromStep, ROLE_TO_SKILL, buildSingleTurnSystemPrompt } from './single-turn-prompt';
import { buildStepRetryFeedback } from './single-turn-visual-feedback';
import { extractSingleTurnBackgroundState } from './single-turn-background-task';
import type { SingleTurnResult } from './single-turn-types';
import {
  captureInteractionBaseline,
  getStepTerminalRequest,
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
  executionEventId: string;
}): Promise<SingleTurnResult> {
  'use step';
  const { sandboxId, plan, step, requirementId, instanceId, siteId, userId, title, gitRepoKind, requirementType, validateDeployment = true, provisionedEnvKeys, executionEventId } = params;
  const audit: CronAuditContext = {
    instanceId: instanceId,
    siteId: siteId,
    userId: userId,
    requirementId: requirementId,
    planId: plan.id,
    stepId: step.id,
  };

  // 1. Connect to Sandbox
  const instanceType = gitRepoKind === 'automation' ? 'automation' : 'applications';
  let infrastructureGeneration =
    Number(step.infrastructure_generation || 0);
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

  // 2. Mark step in_progress if pending
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
    });
    const startMutation = await patchPlanStepAtomically({
      planId: plan.id,
      stepId: step.id,
      expectedGeneration: infrastructureGeneration,
      eventId: `${executionEventId}:start`,
      patch: {
        status: 'in_progress',
        ...(persistedStep.started_at ? {} : { started_at: cycleBaselineAt }),
        ...(nextMetadata ? { metadata: nextMetadata } : {}),
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
      ...(nextMetadata ? { metadata: nextMetadata } : {}),
      infrastructure_generation: infrastructureGeneration,
    };
    const noProgressAdjudication =
      isNoProgressAdjudicationRequested(persistedStep);

    // 3. Build Prompt & Context
    const effectiveRole = step.role || inferRoleFromStep(step) || 'general';
    const skillName = step.skill || (effectiveRole && ROLE_TO_SKILL[effectiveRole]);
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
      step,
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

    const historyText = await fetchStepLogHistoryText(instanceId, plan.id, step.id);
    const messages: any[] = [{
      role: 'user' as const,
      content: `Execute step ${step.order}: ${step.title}. ${step.instructions}`,
    }];

    if (retryFeedback.imageMessage) messages.push(retryFeedback.imageMessage);

    if (historyText) {
      messages.push({
        role: 'user' as const,
        content: `${historyText}\n\nReview the previous actions including any gate failures. Decide the next single tool call to advance the step, or finish the step if completed. REMEMBER: MAXIMUM 1 TOOL CALL.`
      });
    }

    // 5. Call Executor (Max 1 turn)
    const activeSandboxRef = { current: sandbox };
    const sandboxTools = getSandboxTools(sandbox, requirementId, {
      site_id: siteId,
      instance_id: instanceId,
      git_repo_kind: gitRepoKind,
      requirement_type: requirementType,
      validate_deployment: validateDeployment,
      plan_id: plan.id,
      active_step_id: step.id,
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
          sandbox, effectiveSandboxId, plan, step, persistedStep,
          requirementId, instanceId, siteId, userId, requirementType,
          gitRepoKind, backlogItemId: effectiveBacklogItemId,
          interactionBaselineSha, systemPrompt, fullTools, audit,
          infrastructureGeneration, result: {},
        },
      });
    }

    const result = await executeAssistantStep(messages, { id: instanceId, site_id: siteId, user_id: userId, requirement_id: requirementId }, {
      instance_id: instanceId,
      site_id: siteId,
      user_id: userId,
      requirement_id: requirementId,
      plan_id: plan.id,
      step_id: step.id,
      system_prompt: systemPrompt,
      custom_tools: fullTools,
      enforceSingleTurn: true // CRITICAL: enforce 1 tool call max per invocation
    });
    sandbox = activeSandboxRef.current;
    effectiveSandboxId = sandboxIdentity(sandbox);
    const visualFeedbackMutation = await markVisualFeedbackDelivered({
      planId: plan.id,
      instanceId,
      siteId,
      requirementId,
      stepId: step.id,
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

    // Check if the LLM attempted to execute tools and failed due to sandbox gone
    const hasSandboxGoneError = result.messages?.some((m: any) => 
      m.role === 'tool' && isSandboxGoneError(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    );
    
    if (hasSandboxGoneError) {
       console.warn(`[SingleTurn] Sandbox gone detected. Will retry next workflow cycle.`);
       return {
         ok: false,
         isDone: false,
         transient: true,
         error: 'Sandbox Gone 410',
         effectiveSandboxId,
         infrastructureGeneration,
       };
    }

    const { sleepRequested, backgroundTask } = extractSingleTurnBackgroundState(result);
    const terminalRequest = getStepTerminalRequest(result, {
      planId: plan.id,
      stepId: step.id,
    });
    if (terminalRequest?.status === 'failed') {
      return {
        ok: false,
        isDone: true,
        error: terminalRequest.output || `Executor reported failure for step ${step.order}`,
        effectiveSandboxId,
        sleepRequested,
        backgroundTask,
        infrastructureGeneration,
      };
    }
    const completionRequested = terminalRequest?.status === 'completed';
    const shouldRunGate = result.isDone || completionRequested;

    if (completionRequested && !result.isDone) {
      console.log(
        `[SingleTurn] Step ${step.order} requested completion through instance_plan; handing control to the gate.`,
      );
    }

    if (shouldRunGate) {
      return await runSingleTurnGate({
        sandbox,
        effectiveSandboxId,
        plan,
        step,
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
        audit,
        infrastructureGeneration,
        sleepRequested,
        backgroundTask,
      });
    }
    return {
      ok: true,
      isDone: shouldRunGate,
      effectiveSandboxId,
      sleepRequested,
      backgroundTask,
      infrastructureGeneration,
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
