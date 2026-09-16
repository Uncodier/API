import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools, fetchMemoriesContext, generateAgentBackground } from '@/app/api/robots/instance/assistant/utils';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { fetchStepLogHistoryText } from './step-history-builder';
import { SkillsService } from '@/lib/services/skills-service';
import type { GitRepoKind } from './cron-commit-helpers';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { classifyRequirementType, type RequirementKind } from '@/lib/services/requirement-flows';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { SandboxService } from '@/lib/services/sandbox-service';
import { sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { runGateForFlow } from './gates';
import type { AppGateContext } from './gates/types';
import { runArchetypePostGate } from './step-archetype-postgate';
import { inferRoleFromStep, ROLE_TO_SKILL, buildSingleTurnSystemPrompt } from './single-turn-prompt';
import { buildStepRetryFeedback } from './single-turn-visual-feedback';
import { extractSingleTurnBackgroundState } from './single-turn-background-task';
import type { SingleTurnResult } from './single-turn-types';
import {
  buildGateErrorFeedback,
  captureInteractionBaseline,
  getDeclaredProtectedRoutes,
  getStepTerminalRequest,
  withExecuteStepNoop,
} from './single-turn-helpers';
import {
  buildSingleTurnStartMetadata,
  markVisualFeedbackDelivered,
  resolveSingleTurnBacklogItemId,
} from './single-turn-step-state';
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
  provisionedEnvKeys?: string[];
}): Promise<SingleTurnResult> {
  'use step';
  const { sandboxId, plan, step, requirementId, instanceId, siteId, userId, title, gitRepoKind, requirementType, provisionedEnvKeys } = params;
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
    return { ok: false, isDone: false, error: msg, effectiveSandboxId: sandboxId };
  }
  let sandbox = connected.sandbox;
  let effectiveSandboxId = connected.sandboxId;

  // 2. Mark step in_progress if pending
  try {
    let persistedStep = step;
    try {
      const { data: planRow } = await supabaseAdmin
        .from('instance_plans')
        .select('steps, status')
        .eq('id', plan.id)
        .maybeSingle();
        
      const freshStep = Array.isArray(planRow?.steps) ? planRow.steps.find((s: any) => s.id === step.id) : undefined;
      if (freshStep) persistedStep = { ...step, ...freshStep };
      if (freshStep && (freshStep.status === 'completed' || freshStep.status === 'cancelled')) {
        console.log(`[SingleTurn] Step ${step.order} already ${freshStep.status}.`);
        return { ok: true, isDone: true, effectiveSandboxId };
      }
    } catch (e) {}
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
    await updateInstancePlanCore({
      plan_id: plan.id, instance_id: instanceId, site_id: siteId,
      requirement_id: requirementId,
      steps: [{
        id: step.id,
        status: 'in_progress',
        ...(persistedStep.started_at ? {} : { started_at: cycleBaselineAt }),
        ...(nextMetadata ? { metadata: nextMetadata } : {}),
      }],
    });

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
    const { data: instanceData } = await supabaseAdmin.from('instances').select('*').eq('id', instanceId).maybeSingle();
    let agentBackground = '';
    let memoriesContext = '';
    let historyContext = '';
    if (instanceData) {
      agentBackground = await generateAgentBackground(siteId);
      const mems = await fetchMemoriesContext(siteId, userId, instanceId);
      memoriesContext = mems; // fetchMemoriesContext returns a string
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
    });

    // 4. Fetch History
    const historyText = await fetchStepLogHistoryText(instanceId, plan.id, step.id);
    const messages: any[] = [
      { role: 'user' as const, content: `Execute step ${step.order}: ${step.title}. ${step.instructions}` },
    ];

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
      plan_id: plan.id,
      active_step_id: step.id,
      cycle_baseline_at: cycleBaselineAt,
      activeSandboxRef,
    });
    
    const fullTools = withExecuteStepNoop(
      getAssistantTools(
        siteId,
        userId,
        instanceId,
        sandboxTools,
        undefined,
        undefined,
        requirementId,
      ),
    );
    
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
    await markVisualFeedbackDelivered({
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
    });
    
    // Check if the LLM attempted to execute tools and failed due to sandbox gone
    const hasSandboxGoneError = result.messages?.some((m: any) => 
      m.role === 'tool' && isSandboxGoneError(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    );
    
    if (hasSandboxGoneError) {
       console.warn(`[SingleTurn] Sandbox gone detected. Will retry next workflow cycle.`);
       return { ok: false, isDone: false, transient: true, error: 'Sandbox Gone 410', effectiveSandboxId };
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
      // 6. Run Gate right here because we have live sandbox and context
      const flow = classifyRequirementType(requirementType);
      
      let appContext: AppGateContext | undefined;
      if (flow === 'app' || flow === 'site') {
         appContext = {
            planTitle: plan.title,
            stepOrder: step.order,
            backlogItemId: effectiveBacklogItemId,
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
              instance: { id: instanceId, site_id: siteId, user_id: userId, requirement_id: requirementId },
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
              }
            } as any,
            fullTools,
            lastResult: result,
            gitRepoKind
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
         audit
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

      if (!gateRes.ok && gateRes.infrastructureFailure) {
         console.warn(
           `[SingleTurn] Gate infrastructure unavailable for step ${step.order}: ${gateRes.error || 'unknown error'}`,
         );
         return {
           ok: false,
           isDone: false,
           transient: true,
           error: gateRes.error || 'Gate infrastructure unavailable',
           effectiveSandboxId,
         };
      }
      
      if (gateRes.ok) {
         console.log(`[SingleTurn] Gate PASSED for step ${step.order}`);
         let isLastStep = false;
         let pendingStepsCount = 0;
         try {
           const { data: latestPlan } = await supabaseAdmin
             .from('instance_plans')
             .select('steps')
             .eq('id', plan.id)
             .single();
           
           if (latestPlan && Array.isArray(latestPlan.steps)) {
             const pendingSteps = latestPlan.steps.filter((s: any) => 
               s.id !== step.id && (s.status === 'pending' || s.status === 'in_progress')
             );
             pendingStepsCount = pendingSteps.length;
             isLastStep = pendingSteps.length === 0;
           } else {
             const pendingSteps = (plan?.steps || []).filter((s: any) => 
               s.id !== step.id && (s.status === 'pending' || s.status === 'in_progress')
             );
             pendingStepsCount = pendingSteps.length;
             isLastStep = pendingSteps.length === 0;
           }
         } catch (e) {
           console.warn(`[SingleTurn] Error checking isLastStep, falling back to in-memory`, e);
           const pendingSteps = (plan?.steps || []).filter((s: any) => 
             s.id !== step.id && (s.status === 'pending' || s.status === 'in_progress')
           );
           pendingStepsCount = pendingSteps.length;
           isLastStep = pendingSteps.length === 0;
         }
         
         if (isLastStep && effectiveBacklogItemId) {
            console.log(`[SingleTurn] Step ${step.order} is final. Running Post-Gate Archetypes (Critic/Judge)...`);
            await runArchetypePostGate({
               sandbox,
               requirementId,
               backlogItemId: effectiveBacklogItemId,
               stepId: step.id,
               signals: gateRes.richSignals as any,
               capturedAt: new Date().toISOString(),
               audit,
            });
         }
      } else {
         console.log(`[SingleTurn] Gate FAILED for step ${step.order}`);
         await logCronInfrastructureEvent(audit, {
           event: CronInfraEvent.STEP_STATUS,
           level: 'warn',
           message: `Plan step ${step.order} failed gate validation`,
           details: { 
              step_id: step.id, 
              plan_id: plan.id,
              error_excerpt: gateErrorExcerpt.slice(0, 500),
              gate_signals: gateRes.signals,
           }
         });
         
         if (effectiveBacklogItemId) {
            const { bumpItemAttempts, recordToolFailure, logAssumption, downgradeScope, markNeedsReview } = await import('@/lib/services/requirement-backlog');
            const { planNextHealingAction } = await import('@/lib/services/requirement-self-heal');
            const { getBacklogItem } = await import('@/lib/services/requirement-backlog');
            const { classifyFailure } = await import('@/lib/services/failure-classification');
            
            try {
               const { item } = await getBacklogItem(requirementId, effectiveBacklogItemId);
               if (item) {
                   const errorMsg = gateFeedback.raw;
                   const classified = classifyFailure(errorMsg, gateFeedback.categories, {
                     flow: requirementType,
                     signals: gateRes.signals,
                     skipAttemptBump: gateRes.skipAttemptBump,
                   });
                   
                   if (gateRes.skipAttemptBump || classified.failureClass === 'plumbing' || !classified.countsTowardAttempts) {
                     const toolName = classified.toolName || `gate:${requirementType || 'task'}`;
                     console.log(`[SingleTurn] Plumbing failure detected for tool ${toolName}, logging without attempt bump.`);
                     await recordToolFailure({
                       requirementId,
                       itemId: effectiveBacklogItemId,
                       toolName,
                       reason: `[plumbing] Tool ${toolName} failed: ${errorMsg.slice(0, 150)}`
                     });
                   } else {
                     // Product/Judge failure -> consumes attempt and triggers self-heal
                     const bumped = await bumpItemAttempts({
                       requirementId,
                       itemId: effectiveBacklogItemId,
                       reason: `gate_failed: ${errorMsg.slice(0, 200)}`,
                     });
                     
                     const attemptsForHeal = (bumped?.attempts ?? (item.attempts ?? 0) + 1);
                     const action = planNextHealingAction({ 
                        item, 
                        verdict: { verdict: 'rejected', reason: errorMsg || 'Gate failed', matched_acceptance: [], unmatched_acceptance: [] }, 
                        attempts: attemptsForHeal 
                     });
                     
                     switch (action.kind) {
                       case 'rotate_strategy': await logAssumption({ requirementId, itemId: item.id, assumption: `[rotate] ${action.hint}` }); break;
                       case 'downgrade_scope': 
                         await downgradeScope({ requirementId, itemId: item.id });
                         await logAssumption({ requirementId, itemId: item.id, assumption: `[downgrade ${action.from}→${action.to}] ${action.reason}` }); 
                         break;
                       case 'log_assumption_and_continue': await logAssumption({ requirementId, itemId: item.id, assumption: action.assumption }); break;
                       case 'mark_needs_review': await markNeedsReview({ requirementId, itemId: item.id, reason: action.reason }); break;
                     }
                   }
               }
            } catch (healErr) {
               console.error(`[SingleTurn] Exception applying self-healing on gate failure:`, healErr);
            }
         }
      }
      
      return { 
         ok: true, 
         isDone: true, 
         effectiveSandboxId, 
         gatePassed: gateRes.ok, 
         gateErrorExcerpt,
         sleepRequested,
         backgroundTask
      };
    }
    return { ok: true, isDone: shouldRunGate, effectiveSandboxId, sleepRequested, backgroundTask };
  } catch (e: any) {
    console.error('[SingleTurn] Executor wrapper failed:', e);
    const transient = isSandboxGoneError(e.message);
    return { ok: false, isDone: false, transient, error: e.message, effectiveSandboxId };
  }
}
