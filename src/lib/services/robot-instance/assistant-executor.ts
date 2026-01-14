/**
 * Assistant Executor Service
 * Unified execution for OpenAI/Azure assistant without Scrapybara tools
 */

import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { generateImageToolScrapybara } from '@/app/api/agents/tools/generateImage/assistantProtocol';
import { generateVideoToolScrapybara } from '@/app/api/agents/tools/generateVideo/assistantProtocol';
import { renameInstanceToolScrapybara } from '@/app/api/agents/tools/renameInstance/assistantProtocol';

export interface AssistantExecutionOptions {
  use_sdk_tools?: boolean;
  provider?: 'scrapybara' | 'azure' | 'openai';
  system_prompt?: string;
  custom_tools?: any[];
  instance_id?: string;
  site_id?: string;
  user_id?: string;
}

export interface AssistantExecutionResult {
  text: string;
  output: any;
  usage: any;
  steps?: any[];
}

/**
 * Create onStep callback handler for assistant execution
 * Logs steps and tool calls in real-time during execution
 */
function createAssistantOnStepHandler(
  instance_id: string | undefined,
  site_id: string | undefined,
  user_id: string | undefined,
  provider: string
) {
  return async (step: any) => {
    // Log step information
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT STEP] Text: ${step.text?.substring(0, 100) || 'No text'}...`);
    if (step.toolCalls?.length > 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT STEP] Tool calls: ${step.toolCalls.length}`);
    }

    // Only log if instance_id is provided
    if (!instance_id) {
      return;
    }

    // Create parent log for the step
    const logMessage = step.text?.trim() || 'Assistant step execution';
    
    const { data: parentLogData, error: parentLogError } = await supabaseAdmin
      .from('instance_logs')
      .insert({
        log_type: 'agent_action',
        level: 'info',
        message: logMessage,
        tokens_used: step.usage ? {
          promptTokens: step.usage.promptTokens || step.usage.input_tokens,
          completionTokens: step.usage.completionTokens || step.usage.output_tokens,
          totalTokens: step.usage.totalTokens || (step.usage.input_tokens + step.usage.output_tokens),
        } : {},
        details: {
          provider,
          response_type: 'assistant_step',
          raw_text: step.text,
          total_tool_calls: step.toolCalls?.length || 0,
        },
        instance_id: instance_id,
        site_id: site_id,
        user_id: user_id,
      })
      .select()
      .single();

    if (parentLogError) {
      console.error('❌ Error saving assistant step log:', parentLogError);
      return;
    }

    const parentLogId = parentLogData?.id;

    // Log individual tool calls if any
    if (step.toolCalls && step.toolCalls.length > 0 && parentLogId) {
      let savedToolCalls = 0;
      let failedToolCalls = 0;

      for (const toolCall of step.toolCalls) {
        // Find corresponding tool result
        const toolResult = step.toolResults?.find(
          (tr: any) => tr.toolCallId === toolCall.id || tr.toolCallId === toolCall.toolCallId
        );

        // Extract screenshot if it's a computer tool
        let screenshotBase64 = null;
        if (toolResult && toolCall.toolName === 'computer') {
          screenshotBase64 = toolResult.base64Image || null;
        }

        const { error: toolLogError } = await supabaseAdmin.from('instance_logs').insert({
          log_type: 'tool_call',
          level: 'info',
          message: `${toolCall.toolName}: ${toolCall.args ? Object.entries(toolCall.args).map(([k, v]) => `${k}=${v}`).join(', ') : 'no args'}`,
          tool_name: toolCall.toolName,
          tool_call_id: toolCall.id || toolCall.toolCallId,
          tool_args: toolCall.args || {},
          tool_result: toolResult ? {
            success: !toolResult.isError,
            output: (() => {
              // Clean output of any base64 image
              const rawOutput = toolResult.result || toolResult.content || '';
              if (typeof rawOutput === 'string') {
                if (rawOutput.includes('base64,')) {
                  return 'Screenshot captured successfully';
                }
                return rawOutput;
              }
              if (typeof rawOutput === 'object' && rawOutput !== null) {
                const cleanOutput = { ...rawOutput };
                delete cleanOutput.base64Image;
                return cleanOutput;
              }
              return rawOutput;
            })(),
            error: toolResult.isError ? (toolResult.error || toolResult.result) : null,
          } : {},
          screenshot_base64: screenshotBase64,
          parent_log_id: parentLogId,
          duration_ms: step.usage?.duration_ms || null,
          tokens_used: step.usage ? {
            promptTokens: step.usage.promptTokens || step.usage.input_tokens,
            completionTokens: step.usage.completionTokens || step.usage.output_tokens,
            totalTokens: step.usage.totalTokens || (step.usage.input_tokens + step.usage.output_tokens),
          } : {},
          details: {
            provider,
            response_type: 'assistant_tool_call',
            tool_sequence_number: step.toolCalls.indexOf(toolCall) + 1,
            total_tool_calls: step.toolCalls.length,
          },
          instance_id: instance_id,
          site_id: site_id,
          user_id: user_id,
        });

        if (toolLogError) {
          console.error(`❌ Error saving tool log for ${toolCall.toolName}:`, toolLogError);
          failedToolCalls++;
        } else {
          savedToolCalls++;
        }
      }

      if (savedToolCalls > 0 || failedToolCalls > 0) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Tool calls saved: ${savedToolCalls}/${step.toolCalls.length} (${failedToolCalls} failed)`);
      }
    }
  };
}

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
    provider = process.env.ROBOT_SDK_PROVIDER || 'azure',
    system_prompt = 'You are a helpful AI assistant. Provide clear and concise responses.',
    custom_tools = [],
    instance_id,
    site_id,
    user_id,
  } = options || {};

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing assistant with provider: ${provider}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Use SDK tools: ${use_sdk_tools}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Custom tools: ${custom_tools.length}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ System prompt: ${system_prompt.substring(0, 200)}...`);

  try {
    let result: AssistantExecutionResult;

    // Case 1: Using Scrapybara SDK with tools (running instance)
    if (use_sdk_tools && instance?.provider_instance_id && provider === 'scrapybara') {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Using Scrapybara SDK with full tools`);
      
      const client = new ScrapybaraClient({
        apiKey: process.env.SCRAPYBARA_API_KEY || '',
      });

      const remoteInstance = await client.get(instance.provider_instance_id);
      
      // Cast to UbuntuInstance since we expect Ubuntu instances for PC management
      const ubuntuInstance = remoteInstance as any;
      
      // Setup Scrapybara tools using native Scrapybara tools
      const tools = [
        bashTool(ubuntuInstance),
        computerTool(ubuntuInstance),
        editTool(ubuntuInstance),
      ];

      // Convert custom tools to Scrapybara format if needed
      // Replace generateImageTool, generateVideoTool, and renameInstanceTool (OpenAI format) with Scrapybara versions
      const convertedCustomTools = custom_tools.map((tool) => {
        // Check if this is generateImageTool (OpenAI format) by name
        if (tool?.name === 'generate_image' && site_id) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Converting generateImageTool to Scrapybara format`);
          return generateImageToolScrapybara(ubuntuInstance, site_id);
        }
        // Check if this is generateVideoTool (OpenAI format) by name
        if (tool?.name === 'generate_video' && site_id) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Converting generateVideoTool to Scrapybara format`);
          return generateVideoToolScrapybara(ubuntuInstance, site_id);
        }
        // Check if this is renameInstanceTool (OpenAI format) by name
        if (tool?.name === 'rename_instance' && site_id) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Converting renameInstanceTool to Scrapybara format`);
          return renameInstanceToolScrapybara(ubuntuInstance, site_id, instance_id);
        }
        // Keep other tools as-is (assuming they're already Scrapybara-compatible)
        return tool;
      });

      // Execute with Scrapybara - wrap in try-catch for better error handling
      let executionResult;
      try {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing Scrapybara client.act() with ${tools.length + convertedCustomTools.length} tools`);
        executionResult = await client.act({
          model: anthropic(),
          tools: [...tools, ...convertedCustomTools],
          system: system_prompt,
          prompt: prompt,
          onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
        });
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Scrapybara client.act() completed successfully`);
      } catch (actError: any) {
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error in Scrapybara client.act():`, {
          message: actError.message,
          name: actError.name,
          code: actError.code,
          cause: actError.cause?.message || actError.cause,
          stack: actError.stack?.substring(0, 500)
        });
        
        // Check if it's a fetch/network error
        if (actError.message?.includes('fetch failed') || actError.message?.includes('ECONNREFUSED') || actError.cause?.code === 'ECONNREFUSED') {
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ Network error detected - this may indicate:`);
          console.error(`₍ᐢ•(ܫ)•ᐢ₎   1. Scrapybara API endpoint is unreachable`);
          console.error(`₍ᐢ•(ܫ)•ᐢ₎   2. Instance ${instance.provider_instance_id} may be stopped or terminated`);
          console.error(`₍ᐢ•(ܫ)•ᐢ₎   3. Network timeout during streaming`);
          console.error(`₍ᐢ•(ܫ)•ᐢ₎   4. API key or authentication issue`);
        }
        
        // Re-throw with more context
        throw new Error(`Scrapybara execution failed: ${actError.message || 'Unknown error'}. This may be a network issue, instance timeout, or API connectivity problem.`);
      }

      result = {
        text: executionResult.text || '',
        output: executionResult.output || null,
        usage: executionResult.usage || {},
        steps: executionResult.steps || [],
      };
    }
    // Case 2: Using OpenAI/Azure without Scrapybara tools
    else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Using OpenAI/Azure assistant without Scrapybara tools`);
      
      const executor = new OpenAIAgentExecutor();
      
      const executionResult = await executor.act({
        tools: custom_tools, // Only custom tools, no Scrapybara tools
        system: system_prompt,
        prompt: prompt,
        onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
        // No schema for simple chat
      });

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR RESULT] Text length: ${executionResult.text?.length || 0}`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR RESULT] Text preview: ${executionResult.text?.substring(0, 200) || 'EMPTY'}`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR RESULT] Messages count: ${executionResult.messages?.length || 0}`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR RESULT] Steps count: ${executionResult.steps?.length || 0}`);

      // If text is empty, try to extract from messages
      let responseText = executionResult.text || '';
      if (!responseText && executionResult.messages && executionResult.messages.length > 0) {
        const lastMessage = executionResult.messages[executionResult.messages.length - 1];
        if (lastMessage.role === 'assistant' && lastMessage.content) {
          responseText = lastMessage.content;
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FALLBACK] Extracted text from last message: ${responseText.substring(0, 100)}`);
        }
      }

      result = {
        text: responseText,
        output: executionResult.output || null,
        usage: executionResult.usage || {},
        steps: executionResult.steps || [],
      };
    }

    // Log execution summary if instance_id provided
    // Note: Individual steps and tool calls are already logged in real-time via onStep callback
    if (instance_id) {
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

    // Log error if instance_id provided
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

