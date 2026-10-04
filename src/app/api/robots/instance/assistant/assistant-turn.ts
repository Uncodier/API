'use step';

import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import {
  dehydrateMessageImages,
  hydrateMessageImages,
} from '@/lib/services/robot-instance/vision-message-images';
import { getInstanceAssistantTools } from './utils';
import type { AssistantContext } from './types';
import { instrumentWorkflowTools } from '@/lib/services/workflow-robot/execution-tracker';
import { assertAssistantRecoveryActive, runAssistantRecoveryTool } from '@/lib/services/robot-instance/assistant-recovery';
import { resolvePublishNodeBinding } from './publish-node-binding';
import { buildToolExecutionContext } from '@/lib/services/tool-execution-context';
import { SILENT_CONTINUE_PROMPT } from '@/lib/services/robot-instance/assistant-respawn-policy';
import { CONVERSATION_RECOVERY_INSTRUCTION, getConversationRecoveryTools } from './conversation-recovery-tools';

function selectExecutionIntent(initialMessage: string, messages: any[]): string | undefined {
  const usable = (text: unknown): text is string => typeof text === 'string'
    && Boolean(text.trim()) && !text.includes(SILENT_CONTINUE_PROMPT)
    && !text.includes('[Reference Context from linked node ');
  if (usable(initialMessage)) return initialMessage;
  // Recovery injects a synthetic user prompt. Select only the latest actual user
  // text, never serialize assistant/tool history, images, or the system prompt.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content
        .filter((part: any) => (part?.type === 'text' || part?.type === 'input_text') && typeof part.text === 'string')
        .map((part: any) => part.text).join('\n') : undefined;
    if (usable(text)) return text;
  }
}

export async function processAssistantTurn(
  context: AssistantContext,
  messages: any[],
): Promise<any> {
  'use step';

  if (context.recoveryScope) await assertAssistantRecoveryActive(context.recoveryScope);
  if (context.conversationRecoveryOnly && (!context.recoveryScope || context.instanceNodeId)) {
    throw new Error('Conversation recovery requires an owned non-node action');
  }
  const binding = context.instanceNodeId ? await resolvePublishNodeBinding({
    instanceNodeId: context.instanceNodeId,
    instanceId: context.executionOptions.instance_id,
    siteId: context.executionOptions.site_id,
    toolOverrides: context.toolOverrides,
  }) : null;

  // Filtering an already routed `tools` function is unsafe: its closure still
  // contains sends/writes. Expose only plan_result; no dynamic MCP/sandbox.
  const availableTools = context.conversationRecoveryOnly
    ? getConversationRecoveryTools(context.recoveryScope!)
    : context.preResponseOnly
    ? context.customTools.filter((tool) => tool?.name === 'plan_result')
    : await getInstanceAssistantTools(
        context.executionOptions.site_id,
        context.executionOptions.user_id,
        context.executionOptions.instance_id,
        context.customTools,
        context.agentType,
        context.userPhone,
        context.executionOptions.requirement_id,
        context.uiMediaOutputType,
        context.approvedImport,
        buildToolExecutionContext({
          site_id: context.executionOptions.site_id,
          intent: selectExecutionIntent(context.initialMessage, messages),
          source: {
            instance_id: context.executionOptions.instance_id,
            node_id: context.instanceNodeId,
          },
        }),
      );
  const trackedTools = context.toolExecutionTracker && !context.conversationRecoveryOnly
    ? instrumentWorkflowTools(availableTools, context.toolExecutionTracker)
    : availableTools;
  const fullTools = context.recoveryScope || binding ? trackedTools.map((tool) => ({
    ...tool,
    execute: async (...args: any[]) => {
      if (context.recoveryScope) await assertAssistantRecoveryActive(context.recoveryScope);
      // Reapply the server-owned binding at the execution boundary, not only in
      // the model prompt. Defaults and model arguments cannot widen destinations.
      if (binding && tool.name === 'tools' && args[0]?.action === 'call' && args[0]?.name === 'publish') {
        const parsed = typeof args[0].args === 'string' ? JSON.parse(args[0].args) : args[0].args;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid publish arguments');
        const publishArgs = { ...parsed, ...binding.toolOverrides.publish };
        if (!Object.hasOwn(binding.toolOverrides.publish, 'social_accounts')) {
          delete publishArgs.social_accounts;
          delete publishArgs.tiktok;
        }
        args[0] = { ...args[0], args: JSON.stringify(publishArgs) };
      }
      // Multi-output fan-outs have their own non-resumable boundary and parallel writers.
      return context.recoveryScope && (context.expectedResultsAmount ?? 1) === 1
        ? runAssistantRecoveryTool(context.recoveryScope, tool.name, args[0], () => tool.execute(...args))
        : tool.execute(...args);
    },
  })) : trackedTools;
  const options = {
    ...context.executionOptions,
    system_prompt: context.conversationRecoveryOnly ? `${context.systemPrompt}\n\n${CONVERSATION_RECOVERY_INSTRUCTION}`
      : binding ? `${context.systemPrompt}\n${binding.instruction}` : context.systemPrompt,
    custom_tools: fullTools,
    instance_node_id: context.instanceNodeId,
    expected_results_amount: context.expectedResultsAmount,
    tool_overrides: binding?.toolOverrides ?? context.toolOverrides,
    node_continuation: context.nodeContinuation,
  };
  if (context.conversationRecoveryOnly) {
    // A conversation outcome must not be logged or billed as progress on a plan step.
    delete options.plan_id;
    delete options.step_id;
  }

  const hydratedMessages = await hydrateMessageImages(messages);
  const result = await executeAssistantStep(hydratedMessages, context.instance, options);

  if (result?.messages) {
    result.messages = dehydrateMessageImages(result.messages);
  }
  return result;
}

// A model step can publish or send. Never automatically replay its effects.
processAssistantTurn.maxRetries = 0;
