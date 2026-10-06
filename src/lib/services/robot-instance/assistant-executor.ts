/** Bounded assistant execution, including resumable canvas node chunks. */
import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';
import { CreditService } from '@/lib/services/billing/CreditService';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import { createAssistantOnStepHandler, batchCreateResponseNodes } from './assistant-logging';
import { createNodeStreamingCallbacks, createStreamingLogCallbacks, createThinkingStreamLogCallbacks } from './assistant-streaming-logs';
import { hydrateMessageImages } from './vision-message-images';
import { InstanceContextManager } from './InstanceContextManager';
import { measureInstanceContext } from './instance-context-budget';
import { prepareNodeExecutionContext } from './assistant-node-context';
import { createNodeChunkWriter, finalNodeAssistantText } from './assistant-node-results';
import { prepareAssistantTools, type AssistantExecutionOptions, type AssistantStepExecutionResult } from './assistant-execution-options';
export { executeAssistant } from './assistant-executor-legacy';
export { prepareAssistantTools } from './assistant-execution-options';
export type { AssistantExecutionOptions, AssistantExecutionResult, AssistantStepExecutionResult } from './assistant-execution-options';

/**
 * Execute a single step (iteration) of the assistant
 */
export async function executeAssistantStep(
  messages: any[],
  instance: any,
  options: AssistantExecutionOptions
): Promise<AssistantStepExecutionResult> {
  const {
    system_prompt = 'You are a helpful AI assistant.',
    instance_id,
    site_id,
    user_id,
  } = options || {};
  
  const provider = 'openrouter';

  if (site_id) {
    try {
      await CreditService.requireCredits(site_id, 0.001);
    } catch (e: any) {
      console.error('Credit validation failed in step:', e.message);
      throw e;
    }
  }

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing assistant step. Provider: ${provider}, Messages: ${messages.length}`);

  try {
      const prepared = await prepareAssistantTools(instance, options || {});

      // OpenAI / Azure / Gemini - We can step!
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ AI provider - running single iteration`);

      const executor = new AIAgentExecutor({
        provider: options.ai_provider,
        model: options.ai_model,
        siteId: site_id,
      });
      
      const streamingCallbacks = instance_id && site_id
          ? createStreamingLogCallbacks(instance_id, site_id, user_id, provider, options.plan_id, options.step_id, options.requirement_id)
          : undefined;
      
      const thinkingStreamCallbacks = instance_id && site_id
        ? createThinkingStreamLogCallbacks(instance_id, site_id, user_id, provider, options.plan_id, options.step_id, options.requirement_id)
        : undefined;

      const instance_node_id = options.instance_node_id;
      const expectedResults = options.expected_results_amount || 1;
      const nodeContext = await prepareNodeExecutionContext(messages, system_prompt, options);
      const { promptNode, responseNode, contextRefs, systemPrompt: activeSystemPrompt } = nodeContext;
      messages = nodeContext.messages;

      // A node chunk is bounded; exhaustion continues the same conversation/node.
      const nodeMaxIterations = instance_node_id ? 5 : 1;

      let executionResult: any;
      let responseNodeIds: string[] = [];
      let nodeDone = false;

      // --- MULTI-OUTPUT: N > 1 -> fan-out parallel LLM calls ---
      if (promptNode && expectedResults > 1) {
        console.log(`[Node Executor] Multi-output: creating ${expectedResults} response nodes`);

        responseNodeIds = await batchCreateResponseNodes(
          instance_node_id!, promptNode, expectedResults, contextRefs
        );
        if (responseNodeIds.length !== expectedResults) {
          throw new Error('Failed to create all response nodes');
        }

        // Run N independent LLM calls in parallel
        const parallelExecutor = new AIAgentExecutor({
          provider: options?.ai_provider,
          model: options?.ai_model,
          siteId: site_id,
        });
        // Hydrate once before fan-out. hydrateMessageImages mutates content in
        // place; running it inside each parallel call races on shared objects
        // and re-downloads the same images N times.
        const hydratedMessages = await hydrateMessageImages(messages);
        const parallelPromises = responseNodeIds.map(async (nodeId: string, index: number) => {
          const writer = createNodeChunkWriter(nodeId, promptNode);

          try {
            const result = await parallelExecutor.act({
              tools: prepared.tools,
              system: activeSystemPrompt,
              messages: [...hydratedMessages],
              onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider, options?.plan_id, options?.step_id, options?.requirement_id, instance_node_id),
              stream: true,
              onStreamStart: async () => {
                return `node-stream-${nodeId}`;
              },
              onStreamChunk: async (_logId: string, text: string, final = false) => writer.onChunk(text, final),
              maxIterations: nodeMaxIterations,
              enforceSingleTurn: options.enforceSingleTurn,
              toolOverrides: options.tool_overrides,
              enforceContextBudget: Boolean(instance_id && site_id),
            });

            await writer.finish(result);
            return result;
          } catch (err: any) {
            await writer.fail(err.message || 'Unknown error');
            console.error(`[Node Executor] Response node ${index + 1}/${expectedResults} failed: ${nodeId}`, err);
            throw err; // Re-throw so Promise.allSettled can catch it
          }
        });

        // Use Promise.allSettled so we don't abort all if one fails
        const resultsSettled = await Promise.allSettled(parallelPromises);
        const successfulResults = resultsSettled
          .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
          .map(r => r.value);
          
        if (successfulResults.length === 0) {
          // If all failed, throw the first error to trigger standard workflow failure handling
          const firstError = resultsSettled.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
          throw firstError || new Error('All parallel LLM executions failed.');
        }

        const firstValid = successfulResults[0];
        nodeDone = successfulResults.length === expectedResults &&
          successfulResults.every(result => finalNodeAssistantText(result).length > 0);

        // Also run the primary instance_log streaming for the first result
        if (streamingCallbacks && firstValid) {
          const logId = await streamingCallbacks.onStreamStart();
          await streamingCallbacks.onStreamChunk(
            logId,
            firstValid.text || '',
            true,
          );
        }

        // Return the first valid result to maintain compatibility
        executionResult = firstValid;

      // --- SINGLE OUTPUT: N = 1 -> original behavior ---
      } else {
        let nodeWriter: ReturnType<typeof createNodeChunkWriter> | undefined;

        if (promptNode) {
          // Creation is eager and happens only once, before the first model call.
          const nodeResponseId = responseNode?.id || await createNodeStreamingCallbacks(
            instance_node_id!, promptNode, contextRefs,
          ).onNodeStreamStart();
          if (!nodeResponseId) throw new Error('Failed to create a response node');
          responseNodeIds = [nodeResponseId];
          nodeWriter = createNodeChunkWriter(nodeResponseId, promptNode, responseNode?.result);
        }

        // Wrap streaming callbacks to update instance_logs
        const wrappedOnStreamStart = (streamingCallbacks || nodeWriter) ? async () => {
          let logId = 'dummy-log-id';
          if (streamingCallbacks) {
            logId = await streamingCallbacks.onStreamStart();
          }
          return logId;
        } : undefined;

        const wrappedOnStreamChunk = (streamingCallbacks || nodeWriter) ? async (
          logId: string,
          accumulatedText: string,
          final = false,
        ) => {
          if (streamingCallbacks) {
            await streamingCallbacks.onStreamChunk(logId, accumulatedText, final);
          }
          if (nodeWriter) {
            try {
              // A final streaming fragment is not proof that the node is done.
              await nodeWriter.onChunk(accumulatedText, final);
            } catch (e) { /* checkpoint errors are non-fatal */ }
          }
        } : undefined;

        // HYDRATE MESSAGES BEFORE ACTING
        const hydratedMessages = await hydrateMessageImages(messages);

        executionResult = await executor.act({
                tools: prepared.tools,
                system: activeSystemPrompt,
                messages: hydratedMessages,
                onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider, options?.plan_id, options?.step_id, options?.requirement_id, instance_node_id),
                stream: !!streamingCallbacks || !!nodeWriter,
                onStreamStart: wrappedOnStreamStart,
                onStreamChunk: wrappedOnStreamChunk,
                onThinkingStreamStart: thinkingStreamCallbacks?.onThinkingStreamStart,
                onThinkingStreamChunk: thinkingStreamCallbacks?.onThinkingStreamChunk,
                onReasoningTokensUsed: thinkingStreamCallbacks?.onReasoningTokensUsed,
                maxIterations: nodeMaxIterations,
                enforceSingleTurn: options?.enforceSingleTurn,
                toolOverrides: options?.tool_overrides,
                enforceContextBudget: Boolean(instance_id && site_id),
                onContextUsage: !instance_node_id && instance_id && site_id ? async snapshot => {
                  await new InstanceContextManager(instance_id, site_id).recordUsage(
                    measureInstanceContext(snapshot));
                } : undefined,
            });

        if (nodeWriter) nodeDone = await nodeWriter.finish(executionResult);
      }
          
          const lastMessage = executionResult.messages?.[executionResult.messages.length - 1];
          const hasToolCalls = lastMessage?.tool_calls && lastMessage.tool_calls.length > 0;
          
          const lastRole = lastMessage?.role;
          const isDone = instance_node_id
            ? nodeDone
            : (lastRole === 'assistant' && !hasToolCalls);
          
          const result: AssistantStepExecutionResult = {
              text: instance_node_id && nodeDone ? finalNodeAssistantText(executionResult) : executionResult.text,
              output: executionResult.output,
              usage: executionResult.usage,
              steps: executionResult.steps,
              messages: executionResult.messages,
              isDone,
              ...(instance_node_id ? {
                continuation: { responseNodeIds },
                executionStatus: isDone ? 'completed' as const : 'exhausted' as const,
                // Fan-out only returns one transcript; it cannot be safely replayed.
                resumable: !isDone && expectedResults === 1,
              } : {}),
          };
          
          // Deduct credits for token usage
          if (site_id && result.usage && ((result.usage as any).promptTokens || (result.usage as any).input_tokens)) {
            const inputTokens = ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0);
            const outputTokens = ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0);
            const totalTokens = inputTokens + outputTokens;
            
            const tokensCost = (inputTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_INPUT_TOKEN_MILLION + 
                               (outputTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_OUTPUT_TOKEN_MILLION;
            
            if (tokensCost > 0) {
              try {
                await CreditService.deductCredits(
                  site_id,
                  tokensCost,
                  'assistant_tokens',
                  `Assistant step execution (${totalTokens} tokens)`,
                  {
                    tokens: totalTokens,
                    input_tokens: ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0),
                    output_tokens: ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0)
                  }
                );
              } catch (e) {
                console.error('Failed to deduct credits for assistant tokens:', e);
                // Do not run another turn after a confirmed billing rejection.
                if (isInsufficientCreditsError(e)) throw e;
              }
            }
          }
          
          return result;
  } catch (error: any) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing assistant step:`, error);
      throw error;
  }
}
