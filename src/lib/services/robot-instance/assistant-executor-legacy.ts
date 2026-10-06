import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';
import { CreditService } from '@/lib/services/billing/CreditService';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createAssistantOnStepHandler } from './assistant-logging';
import { createStreamingLogCallbacks, createThinkingStreamLogCallbacks } from './assistant-streaming-logs';
import { prepareAssistantTools, type AssistantExecutionOptions, type AssistantExecutionResult } from './assistant-execution-options';

/**
 * Execute assistant with OpenAI/Azure (no Scrapybara tools)
 */
export async function executeAssistant(
  prompt: string,
  instance?: any,
  options?: AssistantExecutionOptions
): Promise<AssistantExecutionResult> {
  const {
    use_sdk_tools = false,
    system_prompt = 'You are a helpful AI assistant. Provide clear and concise responses.',
    custom_tools = [],
    instance_id,
    site_id,
    user_id,
  } = options || {};
  
  const provider = 'openrouter';

  if (site_id) {
    try {
      await CreditService.requireCredits(site_id, 0.001);
    } catch (e: any) {
      console.error('Credit validation failed:', e.message);
      throw e;
    }
  }

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing assistant with provider: ${provider}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Use SDK tools: ${use_sdk_tools}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Custom tools: ${custom_tools.length}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ System prompt: ${system_prompt.substring(0, 200)}...`);

  try {
    let result: AssistantExecutionResult;
    
    const prepared = await prepareAssistantTools(instance, options || {});

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Using AI assistant without Scrapybara tools`);

    const executor = new AIAgentExecutor({
      provider: options?.ai_provider,
      model: options?.ai_model,
      siteId: site_id,
    });
    const streamingCallbacks =
      instance_id && site_id
        ? createStreamingLogCallbacks(instance_id, site_id, user_id, provider)
        : undefined;
    const thinkingStreamCallbacks =
      instance_id && site_id
        ? createThinkingStreamLogCallbacks(instance_id, site_id, user_id, provider)
        : undefined;

    const executionResult = await executor.act({
        tools: prepared.tools, // Use tools from prepared
        system: system_prompt,
        prompt: prompt,
        onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider, options?.plan_id, options?.step_id, options?.requirement_id),
        stream: !!streamingCallbacks,
        onStreamStart: streamingCallbacks?.onStreamStart,
        onStreamChunk: streamingCallbacks?.onStreamChunk,
        onThinkingStreamStart: thinkingStreamCallbacks?.onThinkingStreamStart,
        onThinkingStreamChunk: thinkingStreamCallbacks?.onThinkingStreamChunk,
        onReasoningTokensUsed: thinkingStreamCallbacks?.onReasoningTokensUsed,
        toolOverrides: options?.tool_overrides,
        enforceContextBudget: Boolean(instance_id && site_id),
      });

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR RESULT] Text length: ${executionResult.text?.length || 0}`);
      
      let responseText = executionResult.text || '';
      if (!responseText && executionResult.messages && executionResult.messages.length > 0) {
        const lastMessage = executionResult.messages[executionResult.messages.length - 1];
        if (lastMessage.role === 'assistant' && lastMessage.content) {
          responseText = lastMessage.content;
        }
      }

    result = {
      text: responseText,
      output: executionResult.output || null,
      usage: executionResult.usage || {},
      steps: executionResult.steps || [],
    };

    if (instance_id) {

      // Deduct credits for token usage
      let tokensCost = 0;
      if (result.usage && ((result.usage as any).promptTokens || (result.usage as any).input_tokens)) {
        const inputTokens = ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0);
        const outputTokens = ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0);
        const totalTokens = inputTokens + outputTokens;
        
        tokensCost = (inputTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_INPUT_TOKEN_MILLION + 
                     (outputTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_OUTPUT_TOKEN_MILLION;
        
        if (tokensCost > 0 && site_id) {
          try {
            await CreditService.deductCredits(
              site_id,
              tokensCost,
              'assistant_tokens',
              `Assistant execution (${totalTokens} tokens)`,
              {
                tokens: totalTokens,
                input_tokens: ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0),
                output_tokens: ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0)
              }
            );
          } catch (e) {
            console.error('Failed to deduct credits for assistant tokens:', e);
            if (isInsufficientCreditsError(e)) throw e;
          }
        }
      }

      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'execution_summary',
        level: 'info',
        message: `Assistant execution completed: ${result.text.substring(0, 200)}`,
        details: {
          provider,
          use_sdk_tools,
          custom_tools_count: custom_tools.length,
          prompt_length: prompt.length,
          response_length: result.text.length,
          steps_count: result.steps?.length || 0,
        },
        instance_id: instance_id,
        site_id: site_id,
        user_id: user_id,
        tokens_used: result.usage,
      });
    }

    return result;
  } catch (error: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing assistant:`, error);

    if (instance_id) {
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'error',
        level: 'error',
        message: `Assistant execution failed: ${error.message}`,
        details: {
          error: error.message,
          stack: error.stack,
          provider,
        },
        instance_id: instance_id,
        site_id: site_id,
        user_id: user_id,
      });
    }

    throw error;
  }
}
