/** OpenRouter executor: orchestrate one model turn at a time and settle it before executing tools. */
import { isOpenRouterReasoningModel, resolveOpenRouterModel } from '@/lib/services/ai/openrouter';
import { markAcceptedInferenceFailure } from '@/lib/services/ai/provider-retry-policy';
import type { ActOptions, ActResponse, Message, Step } from './executor/types';
import { runStepHook, runBoundaryHook } from './executor/boundary';
import { ModelTransport } from './executor/model-transport';
import { prepareConversation, prepareIterationRequest } from './executor/request';
import { runToolTurn } from './executor/tool-turn';
import type { ScreenshotState } from './executor/vision';

export type * from './executor/types';

export class AIAgentExecutor extends ModelTransport {
  /**
   * Main execution method that mimics Scrapybara's act() functionality
   */
  async act(options: ActOptions): Promise<ActResponse> {
    if (this.siteId && options.siteId && this.siteId !== options.siteId) {
      throw new Error('OpenRouter billing site does not match executor ownership');
    }
    const { model, system, schema, executionBoundary, maxIterations = 50, onStep, onContextUsage, enforceSingleTurn = false } = options;
    const modelName = model ? resolveOpenRouterModel(model) : this.model;
    const provider = this.provider;
    const isReasoningModel = isOpenRouterReasoningModel(modelName);
    const { finalTools, openaiTools, messages } = prepareConversation(options);
    const screenshots: ScreenshotState = { lastHash: null, identicalCount: 0, history: [] };
    const steps: Step[] = [];
    let totalUsage: ActResponse['usage'] = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let allCompletionCostsKnown = true;
    let inferenceAccepted = false;
    let iterations = 0;
    let finalText = '';
    let finalOutput: any = undefined;
    const MAX_ITERATIONS_WITHOUT_OUTPUT = 30;
    let iterationsWithoutOutput = 0;

    while (iterations < maxIterations) {
      iterations++;

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Iteration ${iterations}/${maxIterations}`);

      if (schema && iterationsWithoutOutput > MAX_ITERATIONS_WITHOUT_OUTPUT) {
        console.error(`⚠️ [EXECUTOR] Safety limit reached: ${iterationsWithoutOutput} iterations without structured output. Stopping.`);
        break;
      }

      try {
        const iterationStartTime = Date.now();
        console.log(`\n⏱️ ========== ITERATION ${iterations} TIMING BREAKDOWN ==========`);
        const capacityModel = this.contextModelId || modelName;
        const completionOptions = await prepareIterationRequest(options, provider, modelName, isReasoningModel, capacityModel,
          options.siteId || this.siteId, messages, openaiTools, iterations);
        const response = await this.requestTurn(options, completionOptions, messages, modelName, openaiTools.length,
          () => { inferenceAccepted = true; });
        const message = response.message;

        if (response.usage) {
          if (onContextUsage && response.usage.prompt_tokens > 0) {
            try {
              await onContextUsage({ system: system || '', messages, tools: completionOptions.tools || [],
                provider, model: capacityModel, providerInputTokens: response.usage.prompt_tokens,
                providerOutputTokens: response.usage.completion_tokens,
                responseFormat: completionOptions.response_format });
            } catch (error) {
              console.warn('[AI EXECUTOR] Provider usage checkpoint unavailable:', executionBoundary ? { redacted: true } : error);
            }
          }
          totalUsage.promptTokens += response.usage.prompt_tokens || 0;
          totalUsage.completionTokens += response.usage.completion_tokens || 0;
          totalUsage.totalTokens += response.usage.total_tokens || 0;
        }
        // A partial sum must never be presented as the actual cost of the whole run.
        if (typeof response.usage?.cost !== 'number' || !Number.isFinite(response.usage.cost)) {
          allCompletionCostsKnown = false;
          delete totalUsage.cost;
        } else if (allCompletionCostsKnown) {
          totalUsage.cost = (totalUsage.cost ?? 0) + response.usage.cost;
        }

        messages.push(message as Message);

        const step: Step = {
          text: message.content || '',
          ...(response.finish_reason ? { finishReason: response.finish_reason } : {}),
          provider,
          model: response.model || modelName,
          ...(response.generationId ? { generationId: response.generationId } : {}),
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
            ...(response.usage?.cost !== undefined ? { cost: response.usage.cost } : {}),
            ...(response.usage?.cost_details !== undefined ? { cost_details: response.usage.cost_details } : {}),
            ...(response.usage?.is_byok !== undefined ? { is_byok: response.usage.is_byok } : {}),
          },
        };

        finalText = message.content || '';

        if (response.finish_reason === 'length') {
          // Never parse/execute a truncated tool call, or treat partial prose as
          // completion. Keep text/usage for a bounded continuation or review.
          // A partial call is not an executed call and must not become a dangling
          // tool_call_id in the continuation transcript.
          delete message.tool_calls;
          if (executionBoundary) await runBoundaryHook(() => executionBoundary.onModelMessage(message));
          steps.push(step);
          if (onStep) await runStepHook(() => onStep(step), executionBoundary);
          if (executionBoundary) await runBoundaryHook(() => executionBoundary.afterTurn(messages), executionBoundary.signal);
          break;
        }

        if (executionBoundary && !message.tool_calls?.length) {
          await runBoundaryHook(() => executionBoundary.onModelMessage(message));
        }

        if (schema && message.content) {
          try {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCHEMA] Attempting to parse structured output...`);
            const parsed = JSON.parse(message.content);
            const validated = schema.parse(parsed);
            step.output = validated;
            finalOutput = validated;
            iterationsWithoutOutput = 0;
            if (!executionBoundary) console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCHEMA] ✅ Structured output validated:`, validated);
          } catch (error) {
            iterationsWithoutOutput++;
            console.log(`⚠️ [SCHEMA] Iterations without output: ${iterationsWithoutOutput}/${MAX_ITERATIONS_WITHOUT_OUTPUT}`);
            console.error('❌ [SCHEMA] Failed to parse structured output:', executionBoundary ? { redacted: true } : error);
            if (!executionBoundary) console.error('❌ [SCHEMA] Message content:', message.content?.substring(0, 200));
          }
        } else {
          if (schema && !message.content) {
            iterationsWithoutOutput++;
            console.log(`⚠️ [SCHEMA] Schema provided but no message content received (${iterationsWithoutOutput}/${MAX_ITERATIONS_WITHOUT_OUTPUT})`);
          } else if (schema) {
            iterationsWithoutOutput++;
          }
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
          const status = await runToolTurn(options, message, messages, finalTools, provider, step, iterations, screenshots);
          if (status === 'retry_parse') continue;
        }

        steps.push(step);

        if (onStep) {
          const streamingLogId = (response as any).streamingLogId;
          await runStepHook(() => onStep(step, streamingLogId ? { streamingLogId } : undefined), executionBoundary);
        }
        if (executionBoundary) await runBoundaryHook(() => executionBoundary.afterTurn(messages), executionBoundary.signal);

        const hasToolCalls = !!(message.tool_calls && message.tool_calls.length > 0);
        const shouldStop = (schema && finalOutput !== undefined) ||
                          !hasToolCalls ||
                          !!enforceSingleTurn;

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Should stop: ${shouldStop} (finish_reason=${(response as any).finish_reason}, hasSchema=${!!schema}, hasOutput=${finalOutput !== undefined}, hasToolCalls=${hasToolCalls}, enforceSingleTurn=${!!enforceSingleTurn})`);

        const iterationEndTime = Date.now();
        const iterationDuration = iterationEndTime - iterationStartTime;
        console.log(`⏱️ [ITERATION_TOTAL] Iteration ${iterations} completed in ${iterationDuration}ms (${(iterationDuration/1000).toFixed(1)}s)`);
        console.log(`⏱️ ========== END ITERATION ${iterations} ==========\n`);

        if (shouldStop) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Breaking loop after ${iterations} iterations`);
          break;
        }

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Continuing to next iteration...`);

      } catch (error: any) {
        if (error?.name === 'OpenRouterBillingError') throw error;
        if (error?.name === 'RecoveryError') throw error;
        if (inferenceAccepted) {
          markAcceptedInferenceFailure(error);
          throw error;
        }
        console.error('[AI EXECUTOR] Execution stopped after an error');

        // Azure-specific content filter; other providers surface their own error shapes.
        if (error.code === 'content_filter' || error.message?.includes('content management policy')) {
          console.error(`❌ [CONTENT_FILTER][${provider}] Provider blocked the response due to content policy`);
          console.error('❌ [CONTENT_FILTER] This may be a false positive. Consider:');
          console.error('   1. Adjusting content filter settings in the provider console');
          console.error('   2. Reviewing recent screenshots for sensitive content');
          console.error('   3. Modifying the system prompt');

          return {
            messages,
            steps,
            text: 'Content filter triggered - execution stopped',
            output: schema ? {
              event: 'step_failed',
              step: iterations,
              assistant_message: `${provider} content filter triggered. The response was blocked due to content policy. This may be a false positive.`
            } : undefined,
            usage: totalUsage,
          };
        }

        if (!executionBoundary && error.message && error.message.includes('tool_call_id')) {
          console.error('⚠️ Tool call mismatch detected.', { messageCount: messages.length });
        }

        throw error;
      }
    }

    return {
      messages,
      steps,
      text: finalText,
      output: finalOutput,
      usage: totalUsage,
    };
  }
}

/**
 * Legacy alias. Prefer {@link AIAgentExecutor} in new code.
 * Kept as a class alias (not a `const`) so `new OpenAIAgentExecutor()` keeps working.
 */
export { AIAgentExecutor as OpenAIAgentExecutor };
