/**
 * Assistant Executor Service
 * Unified execution for OpenAI/Azure assistant without Scrapybara tools
 */

import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';
import { supabaseAdmin } from '@/lib/database/supabase-client';

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

      // Execute with Scrapybara
      const executionResult = await client.act({
        model: anthropic(),
        tools: [...tools, ...custom_tools],
        system: system_prompt,
        prompt: prompt,
      });

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

    // Log assistant response, tool calls, and execution summary if instance_id provided
    if (instance_id) {
      // First, log the assistant's main response as agent_action
      const { data: mainLog, error: mainLogError } = await supabaseAdmin
        .from('instance_logs')
        .insert({
          log_type: 'agent_action',
          level: 'info',
          message: result.text,
          details: {
            provider,
            use_sdk_tools,
            response_type: 'assistant_response',
            prompt_preview: prompt.substring(0, 100),
            steps_count: result.steps?.length || 0,
          },
          instance_id: instance_id,
          site_id: site_id,
          user_id: user_id,
          tokens_used: result.usage,
        })
        .select()
        .single();

      const parentLogId = mainLog?.id || null;

      if (mainLogError) {
        console.error(`❌ Error saving agent_action log:`, mainLogError);
      }

      // Log individual tool calls if any steps exist
      if (result.steps && result.steps.length > 0) {
        let totalToolCalls = 0;
        let savedToolCalls = 0;
        let failedToolCalls = 0;

        for (const step of result.steps) {
          // Log each tool call in this step
          if (step.toolCalls && step.toolCalls.length > 0) {
            for (const toolCall of step.toolCalls) {
              totalToolCalls++;
              
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
                details: {
                  provider,
                  response_type: 'assistant_tool_call',
                  tool_sequence_number: step.toolCalls.indexOf(toolCall) + 1,
                  total_tool_calls: step.toolCalls.length,
                },
                instance_id: instance_id,
                site_id: site_id,
                user_id: user_id,
                tokens_used: step.usage || {},
              });

              if (toolLogError) {
                console.error(`❌ Error saving tool log for ${toolCall.toolName}:`, toolLogError);
                failedToolCalls++;
              } else {
                savedToolCalls++;
              }
            }
          }
        }

        if (totalToolCalls > 0) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Tool calls saved: ${savedToolCalls}/${totalToolCalls} (${failedToolCalls} failed)`);
        }
      }

      // Log execution summary
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

