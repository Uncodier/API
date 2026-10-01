'use workflow';

import { processAssistantTurn } from './assistant-turn';
import { prepareAssistantContext } from './steps';
import { getActiveInstancePlan, executePlanStep, acquirePlanExecutionLockStep, releasePlanExecutionLockStep } from './plan-steps';
import { persistUserMessageStep, markAssistantFailedStep, completeUserMessageStep, pauseUserMessageStep } from './persist-and-fail-steps';
import {
  isIncompleteTurn,
  SILENT_CONTINUE_PROMPT,
} from '@/lib/services/robot-instance/assistant-respawn';
import { spawnSilentContinueStep } from './assistant-respawn-steps';
import type { AssistantSkillSelection } from './skill-selection';
import { prepareRecoveryStep, guardRecoveryStep, checkpointRecoveryStep } from './assistant-recovery-steps';
import type { AssistantRecoveryScope } from '@/lib/services/robot-instance/assistant-recovery';

// Define the workflow step
export async function runAssistantWorkflow(
  instanceId: string,
  message: string,
  siteId: string,
  userId: string,
  customTools: any[],
  useSdkTools: boolean,
  systemPrompt?: string,
  agentType?: string,
  userPhone?: string,
  instanceNodeId?: string,
  expectedResultsAmount?: number,
  contextString?: string,
  toolOverrides?: Record<string, any>,
   options?: { silentContinue?: boolean; selectedSkills?: AssistantSkillSelection; approvedImport?: { url: string; sha256: string; userId: string }; userMessageLogId?: string; resumeToken?: string }
) {
  'use workflow';

  // The HTTP route supplies only the ID it just persisted (not a client ID).
  let userMessageLogId: string | null = options?.userMessageLogId ?? null;
  try {
    const isSilentContinue =
      options?.silentContinue === true || message === SILENT_CONTINUE_PROMPT;
    const blockedResult = {
      instance_id: instanceId, success: false, execution_status: 'paused',
      message: 'Execution context is unavailable, changed, inactive, or already claimed; no automatic restart was performed',
      assistant_response: 'This execution cannot continue safely with its original node and content. Check its status before retrying.',
      instance_node_id: instanceNodeId,
    };
    if (isSilentContinue && (!userMessageLogId || !options?.resumeToken)) return blockedResult;
    if (!isSilentContinue && !userMessageLogId) {
      const logResult = await persistUserMessageStep(instanceId, message, siteId, userId, {
        prompt_source: 'assistant_workflow',
        selected_skills: options?.selectedSkills?.skills.map(({ slug, version }) => ({ slug, version })) ?? [],
        status: 'running', instance_node_id: instanceNodeId,
      });
      userMessageLogId = logResult.id;
    }
    if (!userMessageLogId) return blockedResult;
    const recoveryScope: AssistantRecoveryScope = { instanceId, siteId, userId, userMessageLogId };
    const recovery = await prepareRecoveryStep(recoveryScope, {
      customTools, useSdkTools, systemPrompt, agentType, userPhone, instanceNodeId,
      expectedResultsAmount, contextString, toolOverrides, selectedSkills: options?.selectedSkills,
      approvedImport: options?.approvedImport,
    }, options?.resumeToken);
    if (!recovery.ok) return blockedResult;
    if (recovery.snapshot) {
      const execution = recovery.snapshot.execution;
      customTools = execution.customTools;
      useSdkTools = execution.useSdkTools;
      systemPrompt = execution.systemPrompt;
      agentType = execution.agentType;
      userPhone = execution.userPhone;
      instanceNodeId = execution.instanceNodeId;
      expectedResultsAmount = execution.expectedResultsAmount;
      contextString = execution.contextString;
      toolOverrides = execution.toolOverrides;
      options = { ...options, selectedSkills: execution.selectedSkills as AssistantSkillSelection | undefined,
        approvedImport: execution.approvedImport as { url: string; sha256: string; userId: string } | undefined };
      recoveryScope.generation = recovery.snapshot.respawnCount;
    }

  // Step 1: Prepare context, including automatic history assessment and
  // conditional durable summarization before the first model request.
  const context = await prepareAssistantContext(
    instanceId,
    message,
    siteId,
    userId,
    customTools,
    useSdkTools,
    systemPrompt,
    agentType,
    userPhone,
    instanceNodeId,
    expectedResultsAmount,
    contextString,
    toolOverrides,
    options?.selectedSkills,
    options?.approvedImport,
  );
  context.recoveryScope = recoveryScope;
  context.nodeContinuation = recovery.snapshot?.continuation;

  let isDone = false;
  let finalResult: any = {
    text: '',
    output: null,
    usage: {},
    steps: []
  };

  // Initialize messages with user prompt
  // Note: System prompt is handled separately in context
  let userContent: any = context.initialMessage;
  
  // Attach image assets as short HTTP URLs only. processAssistantTurn hydrates
  // them to data:image inside the LLM step (avoids huge workflow payloads).
  if (!context.instanceNodeId && context.imageAssets && context.imageAssets.length > 0) {
    const refUrls = context.imageAssets
      .map((img: any) => img.publicUrl || (!String(img.url || '').startsWith('data:') ? img.url : null))
      .filter(Boolean);
    const assetUrlsText = refUrls.length
      ? `\n\nCRITICAL - Uploaded Image URLs for reference (YOU MUST PASS THESE URLS EXACTLY AS THEY ARE TO THE APPROPRIATE TOOL PARAMETER, e.g. reference_images):\n${refUrls.join('\n')}`
      : '';

    userContent = [
      { type: 'text', text: context.initialMessage + assetUrlsText }
    ];

    context.imageAssets.forEach((img: any) => {
      const visionUrl = img.publicUrl || img.url;
      if (!visionUrl || String(visionUrl).startsWith('data:')) return;
      userContent.push({
        type: 'image_url',
        image_url: { url: visionUrl }
      });
    });
    console.log(`[Workflow] Attached ${context.imageAssets.length} image asset ref(s) to user message (hydrate in LLM step)`);
  }

  let messages = [
    {
      role: 'user',
      content: userContent
    }
  ];
  if (recovery.snapshot) messages = recovery.snapshot.messages as typeof messages;

  // Step 2: Loop through turns for the main agent conversation
  // Safety limit to prevent infinite loops
  const MAX_TURNS = 20;
  let turns = 0;

  while (!isDone && turns < MAX_TURNS) {
    if (!await guardRecoveryStep(recoveryScope, true)) return blockedResult;
    turns++;
    const stepResult = await processAssistantTurn(context, messages);
    
    // Update state
    messages = stepResult.messages;
    isDone = stepResult.isDone && Boolean(stepResult.text?.trim());
    context.nodeContinuation = stepResult.continuation;
    if (!await checkpointRecoveryStep(recoveryScope, messages, stepResult.continuation)) return blockedResult;
    
    // Update final result
    finalResult = stepResult;
    if (stepResult.executionStatus === 'exhausted' && stepResult.resumable === false) break;
  }

  // Check for stall/exhaustion before plan execution
  if (isIncompleteTurn(finalResult)) {
    if (finalResult.resumable !== false) {
      const spawned = await spawnSilentContinueStep({
        instanceId,
        siteId,
        userId,
        userMessageLogId,
      });
      if (spawned) {
        return {
        instance_id: instanceId,
        status: context.instance.status,
        success: false,
        execution_status: 'continuing',
        message: 'Execution respawned due to incomplete turn',
        assistant_response: finalResult.text,
        output: finalResult.output,
        usage: finalResult.usage,
        instance_node_id: instanceNodeId,
        };
      }
    }
    if (await guardRecoveryStep(recoveryScope)) await pauseUserMessageStep(userMessageLogId);
    return { ...blockedResult, execution_status: 'exhausted',
      message: 'Execution paused without a final answer; original context and completed tool results were retained' };
  }
  if (!await guardRecoveryStep(recoveryScope)) return blockedResult;

  // Step 3: Check for active instance plan AFTER the agent conversation
  // The agent might have just created or updated an instance_plan during its turn
  // If instanceNodeId is present, we SKIP auto-executing plans because Node (Imprenta) executions are single-shot and should not spawn ghost nodes.
  const activePlan = await getActiveInstancePlan(instanceId, siteId);
  
  if (activePlan && !context.hasLinkedRequirement && !instanceNodeId) {
    console.log(`[Workflow] Found active plan: ${activePlan.title} (${activePlan.id})`);
    
    // Filter steps that need execution
    const stepsToExecute = activePlan.steps
      .sort((a: any, b: any) => a.order - b.order)
      .filter((step: any) => step.status === 'pending' || step.status === 'in_progress');

    if (stepsToExecute.length > 0) {
      console.log(`[Workflow] Executing ${stepsToExecute.length} steps from plan`);
      
      const lock = await acquirePlanExecutionLockStep(activePlan.id);
      if (lock.state !== 'acquired') {
        console.log(
          `[Workflow] Could not acquire execution lock for plan ${activePlan.id}: ${lock.state}`,
        );
        if (userMessageLogId) await pauseUserMessageStep(userMessageLogId);
        return {
          instance_id: instanceId,
          status: context.instance.status,
          success: false,
          message: `Plan execution skipped because the lock is ${lock.state}`,
          assistant_response: lock.state === 'contended'
            ? 'Plan execution skipped (already running)'
            : 'Plan execution temporarily unavailable',
        };
      }
      
      try {
        // Plan steps own their continuation; the generic cron must not replay
        // the preceding assistant conversation while a plan performs effects.
        if (!await guardRecoveryStep(recoveryScope, true)) return blockedResult;
        for (const step of stepsToExecute) {
          console.log(`[Workflow] processing plan step: ${step.title}`);
          
          // Execute the step
          const stepResult = await executePlanStep(context, activePlan, step);
          
          // Accumulate results
          finalResult = stepResult;
          if (stepResult.executionStatus === 'exhausted') {
            // A turn budget is a pause, never a successful plan completion or
            // an exception that retries the multi-effect durable step. The
            // finally block releases ownership; a later invocation resumes the
            // same step from its persisted continuation before later steps.
            if (userMessageLogId) await pauseUserMessageStep(userMessageLogId);
            return {
              instance_id: instanceId,
              status: context.instance.status,
              success: false,
              execution_status: 'exhausted',
              resumable: true,
              message: 'Plan execution paused at the step turn limit; the plan is not complete',
              assistant_response: 'This plan step is still incomplete. Its progress has been saved; ask to continue to resume it without restarting completed turns.',
              usage: stepResult.usage,
              plan_id: activePlan.id,
              plan_step_id: stepResult.resumeFromStepId,
              instance_node_id: instanceNodeId,
            };
          }
        }
      } finally {
        await releasePlanExecutionLockStep(activePlan.id, lock.token);
      }
      
      if (userMessageLogId) {
        if (!await guardRecoveryStep(recoveryScope)) return blockedResult;
        await completeUserMessageStep(userMessageLogId);
      }
      return {
        instance_id: instanceId,
        status: context.instance.status,
        message: 'Plan execution completed successfully',
        assistant_response: finalResult.text, // Last step response
        output: finalResult.output,
        usage: finalResult.usage,
        plan_id: activePlan.id,
        instance_node_id: instanceNodeId,
      };
    } else {
        console.log(`[Workflow] Active plan found but no pending steps.`);
    }
  } else if (activePlan && context.hasLinkedRequirement) {
    console.log(`[Workflow] Active plan found but skipping auto-execution because there is a requirement_status linked.`);
  }

    if (userMessageLogId) {
      if (!await guardRecoveryStep(recoveryScope)) return blockedResult;
      await completeUserMessageStep(userMessageLogId);
    }
  return {
    instance_id: instanceId,
    status: context.instance.status,
    message: 'Execution completed successfully',
    assistant_response: finalResult.text,
    output: finalResult.output,
    usage: finalResult.usage,
    instance_node_id: instanceNodeId,
  };
  } catch (error: any) {
    if (error?.name === 'RecoveryError') {
      return { instance_id: instanceId, success: false, execution_status: 'paused', instance_node_id: instanceNodeId,
        message: 'Original execution is inactive or its bound context changed; no automatic restart was performed',
        assistant_response: 'This execution was stopped because its original action or node context is no longer active.' };
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Workflow] Assistant failed after retries for instance ${instanceId}:`, errMsg);
    try {
      await markAssistantFailedStep(instanceId, siteId, userId, errMsg.slice(0, 500), userMessageLogId);
    } catch {
      console.error(`[Workflow] Unable to persist assistant failure for instance ${instanceId}`);
    }
    throw error;
  }
}
