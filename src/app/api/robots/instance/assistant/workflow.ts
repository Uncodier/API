'use workflow';

import { executeAssistantLogic } from './steps';

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
  
  // Call the step function
  return await executeAssistantLogic(
    instanceId,
    message,
    siteId,
    userId,
    customTools,
    useSdkTools,
    systemPrompt
  );
}
