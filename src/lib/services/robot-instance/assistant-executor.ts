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
import { updateSiteSettingsToolScrapybara } from '@/app/api/agents/tools/updateSiteSettings/assistantProtocol';
import { webSearchToolScrapybara } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import {
  saveOnMemoryToolScrapybara,
  getMemoriesToolScrapybara,
} from '@/app/api/agents/tools/memories/assistantProtocol';
import { instancePlanTool } from '@/app/api/agents/tools/instance_plan/assistantProtocol';
import {
  createAssistantOnStepHandler,
  createStreamingLogCallbacks,
  createThinkingStreamLogCallbacks
} from './assistant-logging';

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
 * Prepare tools for assistant execution
 */
export async function prepareAssistantTools(
  instance: any,
  options: AssistantExecutionOptions
) {
  const {
    use_sdk_tools = false,
    provider = process.env.ROBOT_SDK_PROVIDER || 'azure',
    custom_tools = [],
    site_id,
    user_id,
    instance_id,
  } = options;

  // Case 1: Using Scrapybara SDK with tools (running instance)
  if (use_sdk_tools && instance?.provider_instance_id && provider === 'scrapybara') {
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
      const convertedCustomTools = custom_tools.flatMap((tool) => {
        // Check if this is generateImageTool (OpenAI format) by name
        if (tool?.name === 'generate_image' && site_id) {
          return generateImageToolScrapybara(ubuntuInstance, site_id);
        }
        // Check if this is generateVideoTool (OpenAI format) by name
        if (tool?.name === 'generate_video' && site_id) {
          return generateVideoToolScrapybara(ubuntuInstance, site_id);
        }
        // Check if this is renameInstanceTool (OpenAI format) by name
        if (tool?.name === 'rename_instance' && site_id) {
          return renameInstanceToolScrapybara(ubuntuInstance, site_id, instance_id);
        }
        // Check if this is updateSiteSettingsTool (OpenAI format) by name
        if (tool?.name === 'update_site_settings' && site_id) {
          return updateSiteSettingsToolScrapybara(ubuntuInstance, site_id);
        }
        // Check if this is webSearch (OpenAI format) by name
        if (tool?.name === 'webSearch') {
          return webSearchToolScrapybara(ubuntuInstance);
        }
        // Check if this is memories (unified tool) - use both Scrapybara tools for full compatibility
        if (tool?.name === 'memories' && site_id) {
          return [
            saveOnMemoryToolScrapybara(ubuntuInstance, site_id, user_id ?? '', instance_id),
            getMemoriesToolScrapybara(ubuntuInstance, site_id, user_id, instance_id),
          ];
        }
        // Check if this is instance_plan (unified tool) - use the Scrapybara tool
        if (tool?.name === 'instance_plan' && site_id && instance_id) {
          return instancePlanTool(site_id, instance_id, user_id);
        }
        return tool;
      });

      return {
          type: 'scrapybara',
          client,
          tools: [...tools, ...convertedCustomTools],
          ubuntuInstance
      };
  } else {
      // Case 2: OpenAI/Azure
      return {
          type: 'openai',
          tools: custom_tools
      };
  }
}

/**
 * Execute a single step (iteration) of the assistant
 */
export async function executeAssistantStep(
  messages: any[],
  instance: any,
  options: AssistantExecutionOptions
): Promise<AssistantExecutionResult & { messages: any[], isDone: boolean }> {
  const {
    provider = process.env.ROBOT_SDK_PROVIDER || 'azure',
    system_prompt = 'You are a helpful AI assistant.',
    instance_id,
    site_id,
    user_id,
  } = options || {};

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing assistant step. Provider: ${provider}, Messages: ${messages.length}`);

  try {
      const prepared = await prepareAssistantTools(instance, options || {});

      if (prepared.type === 'scrapybara') {
           const client = (prepared as any).client as ScrapybaraClient;
           const tools = prepared.tools;
           if (!client) throw new Error('Scrapybara client not initialized');
           
           // Fallback to full execution for Scrapybara for now
           
           const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user');
           const prompt = lastUserMessage?.content || 'Continue';

           const executionResult = await client.act({
              model: anthropic(),
              tools: tools,
              system: system_prompt,
              prompt: typeof prompt === 'string' ? prompt : 'User sent an image or complex content', 
              onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
            });

            return {
                text: executionResult.text || '',
                output: executionResult.output || null,
                usage: executionResult.usage || {},
                steps: executionResult.steps || [],
                messages: [], 
                isDone: true
            };

      } else {
          // OpenAI / Azure - We can step!
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ OpenAI/Azure provider - running single iteration`);
          
          const executor = new OpenAIAgentExecutor();
          
          const streamingCallbacks = instance_id && site_id
              ? createStreamingLogCallbacks(instance_id, site_id, user_id, provider)
              : undefined;
          
          const thinkingStreamCallbacks = instance_id && site_id
            ? createThinkingStreamLogCallbacks(instance_id, site_id, user_id, provider)
            : undefined;

          const executionResult = await executor.act({
              tools: prepared.tools,
              system: system_prompt,
              messages: messages, // Pass current history
              onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
              stream: !!streamingCallbacks,
              onStreamStart: streamingCallbacks?.onStreamStart,
              onStreamChunk: streamingCallbacks?.onStreamChunk,
              onThinkingStreamStart: thinkingStreamCallbacks?.onThinkingStreamStart,
              onThinkingStreamChunk: thinkingStreamCallbacks?.onThinkingStreamChunk,
              onReasoningTokensUsed: thinkingStreamCallbacks?.onReasoningTokensUsed,
              maxIterations: 1, // FORCE SINGLE STEP
          });
          
          const lastMessage = executionResult.messages[executionResult.messages.length - 1];
          const hasToolCalls = lastMessage?.tool_calls && lastMessage.tool_calls.length > 0;
          
          const lastRole = lastMessage?.role;
          const isDone = lastRole === 'assistant' && !hasToolCalls;
          
          return {
              text: executionResult.text,
              output: executionResult.output,
              usage: executionResult.usage,
              steps: executionResult.steps,
              messages: executionResult.messages,
              isDone: isDone
          };
      }
  } catch (error: any) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing assistant step:`, error);
      throw error;
  }
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
    
    // Reuse prepareAssistantTools logic implicitly or explicitly?
    // Using prepareAssistantTools would be cleaner but let's stick to the original implementation 
    // pattern to be absolutely safe, but I'll use the extracted logic if I can.
    // Actually, I'll copy the logic back or use the new helper. 
    // Using the new helper is better for consistency.
    
    const prepared = await prepareAssistantTools(instance, options || {});

    if (prepared.type === 'scrapybara') {
      const client = (prepared as any).client as ScrapybaraClient;
      const tools = prepared.tools;
      if (!client) throw new Error('Scrapybara client not initialized');
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Using Scrapybara SDK with full tools`);
      
      let executionResult;
      try {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing Scrapybara client.act() with ${tools.length} tools`);
        executionResult = await client.act({
          model: anthropic(),
          tools: tools,
          system: system_prompt,
          prompt: prompt,
          onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
        });
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Scrapybara client.act() completed successfully`);
      } catch (actError: any) {
         // ... error handling
         console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error in Scrapybara client.act():`, actError);
         throw new Error(`Scrapybara execution failed: ${actError.message || 'Unknown error'}`);
      }
      
      result = {
        text: executionResult.text || '',
        output: executionResult.output || null,
        usage: executionResult.usage || {},
        steps: executionResult.steps || [],
      };
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Using OpenAI/Azure assistant without Scrapybara tools`);
      
      const executor = new OpenAIAgentExecutor();
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
        onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
        stream: !!streamingCallbacks,
        onStreamStart: streamingCallbacks?.onStreamStart,
        onStreamChunk: streamingCallbacks?.onStreamChunk,
        onThinkingStreamStart: thinkingStreamCallbacks?.onThinkingStreamStart,
        onThinkingStreamChunk: thinkingStreamCallbacks?.onThinkingStreamChunk,
        onReasoningTokensUsed: thinkingStreamCallbacks?.onReasoningTokensUsed,
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
    }

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
