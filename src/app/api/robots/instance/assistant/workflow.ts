'use workflow';

import { prepareAssistantContext, processAssistantTurn } from './steps';
import { getActiveInstancePlan, executePlanStep } from './plan-steps';
import { persistUserMessageStep, markAssistantFailedStep } from './persist-and-fail-steps';
import { isIncompleteTurn, MAX_RESPAWNS } from '@/lib/services/robot-instance/assistant-respawn';
import { countRecentRespawnsStep, spawnSilentContinueStep } from './assistant-respawn-steps';

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
  options?: { silentContinue?: boolean }
) {
  'use workflow';

  try {
    if (!options?.silentContinue) {
      await persistUserMessageStep(instanceId, message, siteId, userId, {
        prompt_source: 'assistant_workflow',
      });
    }

  // Step 1: Prepare context
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
    contextString
  );

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
  if (context.imageAssets && context.imageAssets.length > 0) {
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

  // Step 2: Loop through turns for the main agent conversation
  // Safety limit to prevent infinite loops
  const MAX_TURNS = 20;
  let turns = 0;

  while (!isDone && turns < MAX_TURNS) {
    turns++;
    const stepResult = await processAssistantTurn(context, messages);
    
    // Update state
    messages = stepResult.messages;
    isDone = stepResult.isDone;
    
    // Update final result
    finalResult = stepResult;
  }

  // Check for stall/exhaustion before plan execution
  if (isIncompleteTurn(finalResult)) {
    const respawnCount = await countRecentRespawnsStep(instanceId);
    if (respawnCount < MAX_RESPAWNS) {
      console.log(`[Workflow] Incomplete turn detected (turns: ${turns}), respawning... (count: ${respawnCount})`);
      await spawnSilentContinueStep({
        instanceId,
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
      });
      return {
        instance_id: instanceId,
        status: context.instance.status,
        message: 'Execution respawned due to incomplete turn',
        assistant_response: finalResult.text,
        output: finalResult.output,
        usage: finalResult.usage,
        instance_node_id: instanceNodeId,
      };
    } else {
      console.log(`[Workflow] Incomplete turn detected but max respawns reached (${respawnCount})`);
    }
  }

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
      
      for (const step of stepsToExecute) {
        console.log(`[Workflow] processing plan step: ${step.title}`);
        
        // Execute the step
        const stepResult = await executePlanStep(context, activePlan, step);
        
        // Accumulate results
        finalResult = stepResult;
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
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Workflow] Assistant failed after retries for instance ${instanceId}:`, errMsg);
    await markAssistantFailedStep(instanceId, siteId, userId, errMsg.slice(0, 500));
    throw error;
  }
}
