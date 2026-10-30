import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import {
  dehydrateMessageImages,
  hydrateMessageImages,
} from '@/lib/services/robot-instance/vision-message-images';
import { getInstanceAssistantTools } from './utils';
import type { AssistantContext } from './types';
import { instrumentWorkflowTools } from '@/lib/services/workflow-robot/execution-tracker';
import { assertAssistantRecoveryActive, runAssistantRecoveryTool } from '@/lib/services/robot-instance/assistant-recovery';
import { resolvePublishNodeBinding } from './publish-node-binding';
import { assertPublishNodeToolAllowed, enforcePublishDestinationArgs } from '@/lib/messaging/publish-destinations';
import { buildToolExecutionContext } from '@/lib/services/tool-execution-context';
import { SILENT_CONTINUE_PROMPT } from '@/lib/services/robot-instance/assistant-respawn-policy';
import { CONVERSATION_RECOVERY_INSTRUCTION, getConversationRecoveryTools } from './conversation-recovery-tools';
import { readRequirementAssistantHost, guardRequirementAssistantTools, filterRequirementEnvironmentTools, readAssistantStepResult } from './requirement-host';

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
  const requirementHost = readRequirementAssistantHost(context);
  if (requirementHost) await requirementHost.assertActive();
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
  // Trusted action scope, not a model flag or the presence of a requirement.
  // Requirement runners and workflow/node hosts already own their environments.
  const standaloneFiles = !requirementHost && context.recoveryScope && !context.instanceNodeId &&
    !context.preResponseOnly && !context.conversationRecoveryOnly;
  const fileScope = { instanceId: context.executionOptions.instance_id, siteId: context.executionOptions.site_id,
    userId: context.executionOptions.user_id, requirementId: context.executionOptions.requirement_id };
  const fileContext = standaloneFiles ? await (await import('./cloud-context')).resolveAssistantFileEnvironment(fileScope) : {};
  const assertFileContext = async () => {
    await assertAssistantRecoveryActive(context.recoveryScope!);
    const current = await (await import('./cloud-context')).resolveAssistantFileEnvironment(fileScope);
    if (current.environment !== fileContext.environment || current.requirementId !== fileContext.requirementId) {
      throw new Error('Requirement file binding changed; refresh the conversation before file operations');
    }
  };
  const cloudTools = standaloneFiles && fileContext.environment !== 'workspace'
    ? (await import('@/lib/cloud-files/tools')).createCloudFileTools({ ...fileScope, requirementId: fileContext.requirementId },
      assertFileContext) : [];
  const workspaceTools = !requirementHost && context.recoveryScope && !context.instanceNodeId &&
    !context.preResponseOnly && !context.conversationRecoveryOnly &&
    fileContext.environment !== 'cloud' &&
    !context.customTools.some(tool => ['list_files', 'read_files', 'sandbox_list_files', 'sandbox_read_file'].includes(tool?.name))
    ? (await import('./workspace-tools')).createAssistantWorkspaceTools({ instanceId: context.executionOptions.instance_id,
      siteId: context.executionOptions.site_id, userId: context.executionOptions.user_id },
    () => assertAssistantRecoveryActive(context.recoveryScope!)) : [];

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
        requirementHost ? [...context.customTools, ...requirementHost.tools] : [...context.customTools, ...workspaceTools, ...cloudTools],
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
        context.recoveryScope && context.executionOptions.user_id ? {
          siteId: context.executionOptions.site_id,
          userId: context.executionOptions.user_id,
          instanceId: context.executionOptions.instance_id,
          actionId: context.recoveryScope.userMessageLogId,
        } : undefined,
        requirementHost ? tools => guardRequirementAssistantTools(requirementHost, tools) : fileContext.environment
          ? tools => filterRequirementEnvironmentTools(fileContext.environment, tools) : undefined,
      );
  const trackedTools = context.toolExecutionTracker && !context.conversationRecoveryOnly
    ? instrumentWorkflowTools(availableTools, context.toolExecutionTracker)
    : availableTools;
  const fullTools = trackedTools.map((tool) => ({
    ...tool,
    execute: async (...args: any[]) => {
      if (readAssistantStepResult(context)) return { success: false, executed: false,
        error: { code: 'STEP_RESULT_ALREADY_REPORTED', message: 'The step result was reported; no further tools were executed.', effectStarted: false } };
      if (context.recoveryScope) await assertAssistantRecoveryActive(context.recoveryScope);
      if (binding && tool.name === 'tools' && args[0]?.action === 'call') assertPublishNodeToolAllowed(args[0]?.name);
      if (binding && tool.name !== 'tools') assertPublishNodeToolAllowed(tool.name);
      // Reapply the server-owned binding at the execution boundary, not only in
      // the model prompt. Defaults and model arguments cannot widen destinations.
      if (binding && tool.name === 'tools' && args[0]?.action === 'call' && ['publish', 'sendBulkMessages'].includes(args[0]?.name)) {
        const parsed = typeof args[0].args === 'string' ? JSON.parse(args[0].args) : args[0].args;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid publish arguments');
        const publishArgs = enforcePublishDestinationArgs(parsed, binding.toolOverrides[args[0].name] ?? {}, args[0].name);
        args[0] = { ...args[0], args: JSON.stringify(publishArgs) };
      }
      // Multi-output fan-outs have their own non-resumable boundary and parallel writers.
      return context.recoveryScope && (context.expectedResultsAmount ?? 1) === 1
        ? runAssistantRecoveryTool(context.recoveryScope, tool.name, args[0], () => tool.execute(...args))
        : tool.execute(...args);
    },
  }));
  const options = {
    ...context.executionOptions,
    system_prompt: context.conversationRecoveryOnly ? `${context.systemPrompt}\n\n${CONVERSATION_RECOVERY_INSTRUCTION}`
      : binding ? `${context.systemPrompt}\n${binding.instruction}` : context.systemPrompt,
    custom_tools: fullTools,
    instance_node_id: context.instanceNodeId,
    expected_results_amount: context.expectedResultsAmount,
    tool_overrides: binding?.toolOverrides ?? context.toolOverrides,
    node_continuation: context.nodeContinuation,
    ...(requirementHost ? {
      executionBoundary: requirementHost.boundary,
    } : {}),
  };
  if (requirementHost) {
    options.system_prompt += `\n\nCURRENT REQUIREMENT EXECUTION CONTEXT\n${await requirementHost.refreshContext()}`;
  }
  if (standaloneFiles) options.system_prompt += fileContext.environment === 'cloud'
    ? '\nThis requirement produces private cloud documents and Git evidence, not an app. Use cloud file tools scoped to its requirement_id; do not start or search a sandbox.'
    : fileContext.environment === 'workspace' ? '\nThis requirement uses its workspace. Do not search cloud files for its repository files.'
      : '\nCloud file tools manage private documents without a VM. Workspace tools explicitly request an executable filesystem. Choose the source requested by the user; never search both by default.';
  if (context.conversationRecoveryOnly) {
    // A conversation outcome must not be logged or billed as progress on a plan step.
    delete options.plan_id;
    delete options.step_id;
  }

  const hydratedMessages = await hydrateMessageImages(messages);
  let result;
  try {
    result = await executeAssistantStep(hydratedMessages, context.instance, options);
  } catch (error) {
    // Carry billing as data across the durable boundary: exhausted retry wrappers
    // can otherwise discard the original error name/cause.
    if (isInsufficientCreditsError(error)) return { creditExhausted: true, isDone: false, text: '', messages };
    throw error;
  }

  if (result?.messages) {
    result.messages = dehydrateMessageImages(result.messages);
  }
  return result;
}

