'use workflow';

import { prepareAssistantContext, processAssistantTurn } from './steps';

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

  // Initialize messages with user prompt
  // Note: System prompt is handled separately in context
  let messages = [
    {
      role: 'user',
      content: context.initialMessage
    }
  ];

  let isDone = false;
  let finalResult: any = {
    text: '',
    output: null,
    usage: {},
    steps: []
  };

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
