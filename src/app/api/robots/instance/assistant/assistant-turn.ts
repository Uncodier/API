'use step';

import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import {
  dehydrateMessageImages,
  hydrateMessageImages,
} from '@/lib/services/robot-instance/vision-message-images';
import { getInstanceAssistantTools } from './utils';
import type { AssistantContext } from './types';

export async function processAssistantTurn(
  context: AssistantContext,
  messages: any[],
): Promise<any> {
  'use step';

  const fullTools = await getInstanceAssistantTools(
    context.executionOptions.site_id,
    context.executionOptions.user_id,
    context.executionOptions.instance_id,
    context.customTools,
    context.agentType,
    context.userPhone,
    context.executionOptions.requirement_id,
    context.uiMediaOutputType,
  );
  const options = {
    ...context.executionOptions,
    system_prompt: context.systemPrompt,
    custom_tools: fullTools,
    instance_node_id: context.instanceNodeId,
    expected_results_amount: context.expectedResultsAmount,
    tool_overrides: context.toolOverrides,
  };

  const hydratedMessages = await hydrateMessageImages(messages);
  const result = await executeAssistantStep(hydratedMessages, context.instance, options);

  if (result?.messages) {
    result.messages = dehydrateMessageImages(result.messages);
  }
  return result;
}
