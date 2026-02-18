'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getInstancePlansCore } from '@/app/api/agents/tools/instance_plan/get/route';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { AssistantContext, processAssistantTurn } from './steps';

/**
 * Fetch the active instance plan for the given instance and site.
 * Returns null if no active plan is found.
 */
export async function getActiveInstancePlan(
  instanceId: string,
  siteId: string
) {
  'use step';
  
  try {
    const result = await getInstancePlansCore({
      instance_id: instanceId,
      site_id: siteId,
      status: 'in_progress', // We only care about in_progress plans, or maybe pending too?
      limit: 1,
    });

    if (result.success && result.data.plans.length > 0) {
      return result.data.plans[0];
    }
    
    // Check for pending plans if no in_progress one exists
    const pendingResult = await getInstancePlansCore({
        instance_id: instanceId,
        site_id: siteId,
        status: 'pending',
        limit: 1,
      });

    if (pendingResult.success && pendingResult.data.plans.length > 0) {
        // Automatically start the pending plan?
        // For now, let's return it. The workflow can decide to start it.
        return pendingResult.data.plans[0];
    }

    return null;
  } catch (error) {
    console.error('[PlanSteps] Error fetching active plan:', error);
    return null;
  }
}

/**
 * Execute a single step of the instance plan.
 */
export async function executePlanStep(
  context: AssistantContext,
  plan: any,
  step: any
) {
  'use step';

  console.log(`[PlanSteps] Executing step ${step.order}: ${step.title}`);

  // 1. Update step status to in_progress
  await updateInstancePlanCore({
    plan_id: plan.id,
    instance_id: context.executionOptions.instance_id,
    site_id: context.executionOptions.site_id,
    steps: [{
      id: step.id,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    }]
  });

  // 2. Prepare context for this step
  // We modify the system prompt to focus on this step
  const stepContextPrompt = `
\n\n📋 CURRENT PLAN EXECUTION:
You are currently executing a plan: "${plan.title}".
Description: ${plan.description}

👉 CURRENT STEP (Step ${step.order}):
Title: ${step.title}
Instructions: ${step.instructions}
Expected Output: ${step.expected_output}

⚠️ INSTRUCTIONS FOR THIS STEP:
- Focus ONLY on completing this specific step.
- Use available tools if necessary.
- Provide the output of this step clearly.
`;

  const modifiedContext = {
    ...context,
    systemPrompt: context.systemPrompt + stepContextPrompt
  };

  const messages = [
    {
      role: 'user',
      content: `Execute step ${step.order}: ${step.title}. ${step.instructions}`
    }
  ];

  // 3. Execute the assistant for this step
  // We need a loop to handle potential tool calls within a single plan step
  // similar to the main workflow loop
  
  let stepResult;
  let currentMessages = [...messages];
  let isStepDone = false;
  let turns = 0;
  const MAX_STEP_TURNS = 10; // Avoid infinite loops within a step

  try {
    while (!isStepDone && turns < MAX_STEP_TURNS) {
      turns++;
      console.log(`[PlanSteps] Executing turn ${turns} for step ${step.order}`);
      
      stepResult = await processAssistantTurn(modifiedContext, currentMessages);
      
      // Update state
      currentMessages = stepResult.messages;
      isStepDone = stepResult.isDone;

      // If the assistant provides a text response, we consider the step "done" 
      // unless there are pending tool calls (which isDone handles usually)
      // But checking stepResult.text might be useful if we want to ensure we have an output.
    }
    
    if (!stepResult) {
        throw new Error('No result from assistant execution');
    }

  } catch (error: any) {
      console.error(`[PlanSteps] Step execution failed:`, error);
      
      // Update step status to failed
      await updateInstancePlanCore({
        plan_id: plan.id,
        instance_id: context.executionOptions.instance_id,
        site_id: context.executionOptions.site_id,
        steps: [{
            id: step.id,
            status: 'failed',
            error_message: error.message,
            completed_at: new Date().toISOString(),
        }]
      });
      throw error;
  }

  // 4. Update step status to completed and save output
  await updateInstancePlanCore({
    plan_id: plan.id,
    instance_id: context.executionOptions.instance_id,
    site_id: context.executionOptions.site_id,
    steps: [{
      id: step.id,
      status: 'completed',
      actual_output: stepResult.text,
      completed_at: new Date().toISOString(),
    }]
  });

  return stepResult;
}
