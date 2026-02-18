'use workflow';

import { prepareAssistantContext, processAssistantTurn } from './steps';
import { getActiveInstancePlan, executePlanStep } from './plan-steps';

// Define the workflow step
export async function runAssistantWorkflow(
  instanceId: string,
  message: string,
  siteId: string,
  userId: string,
  customTools: any[],
  useSdkTools: boolean,
  systemPrompt?: string
) {
  'use workflow';
  
  // Step 1: Prepare context
  const context = await prepareAssistantContext(
    instanceId,
    message,
    siteId,
    userId,
    customTools,
    useSdkTools,
    systemPrompt
  );

  let isDone = false;
  let finalResult: any = {
    text: '',
    output: null,
    usage: {},
    steps: []
  };

  // Step 1.5: Check for active instance plan
  const activePlan = await getActiveInstancePlan(instanceId, siteId);
  
  if (activePlan) {
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
        // Each step is a chat completion
        const stepResult = await executePlanStep(context, activePlan, step);
        
        // Accumulate results
        finalResult = stepResult;
        
        // If step failed, stop execution
        // We catch errors inside executePlanStep but we should check here too if we want to break
        // Actually executePlanStep throws on error, so workflow will fail/stop here which is correct.
      }
      
      return {
        instance_id: instanceId,
        status: context.instance.status,
        message: 'Plan execution completed successfully',
        assistant_response: finalResult.text, // Last step response
        output: finalResult.output,
        usage: finalResult.usage,
        plan_id: activePlan.id
      };
    } else {
        console.log(`[Workflow] Active plan found but no pending steps.`);
        // Fallback to normal chat if plan is done? or just return?
        // Let's fallback to normal chat, maybe the user wants to discuss the plan.
    }
  }

  // Initialize messages with user prompt
  // Note: System prompt is handled separately in context
  let messages = [
    {
      role: 'user',
      content: context.initialMessage
    }
  ];

  // Step 2: Loop through turns
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

  return {
    instance_id: instanceId,
    status: context.instance.status,
    message: 'Execution completed successfully',
    assistant_response: finalResult.text,
    output: finalResult.output,
    usage: finalResult.usage,
  };
}
