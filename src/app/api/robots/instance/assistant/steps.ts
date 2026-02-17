'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';
import {
  fetchMemoriesContext,
  generateAgentBackground,
  getAssistantTools,
  determineInstanceCapabilities,
  ICP_CATEGORY_IDS_INSTRUCTION
} from './utils';

// Define the core logic as a step function
export async function executeAssistantLogic(
  instanceId: string,
  message: string,
  siteId: string,
  userId: string,
  customTools: any[],
  useSdkTools: boolean,
  systemPrompt?: string
) {
  'use step';
  
  // We need to fetch the instance data inside the workflow to ensure we have the latest state
  const { data: instance, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .select('*')
    .eq('id', instanceId)
    .single();

  if (instanceError || !instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  // Log execution start (optional, but good for debugging)
  console.log(`[Workflow] Starting assistant execution for instance: ${instanceId}`);

  // Fetch historical logs
  const { data: historicalLogs } = await supabaseAdmin
    .from('instance_logs')
    .select('log_type, message, created_at, tool_name, tool_result')
    .eq('instance_id', instanceId)
    .in('log_type', ['user_action', 'agent_action', 'execution_summary', 'tool_call'])
    .order('created_at', { ascending: true })
    .limit(500);

  // Build history context
  let historyContext = '';
  if (historicalLogs && historicalLogs.length > 0) {
    historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
    historicalLogs.forEach((log) => {
      const timestamp = new Date(log.created_at).toLocaleTimeString();
      const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
      
      if (log.log_type === 'tool_call' && log.tool_name && log.tool_result) {
        if (['generate_image', 'generate_video'].includes(log.tool_name)) {
            const toolResult = log.tool_result;
            const outputKey = log.tool_name === 'generate_image' ? 'images' : 'videos';
            if (toolResult.success && toolResult.output && toolResult.output[outputKey]) {
              const urls = toolResult.output[outputKey].map((item: any) => item.url).filter(Boolean);
              if (urls.length > 0) {
                historyContext += `[${timestamp}] ${role}: Generated ${log.tool_name} - URLs: ${urls.join(', ')}\n`;
              } else {
                historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
              }
            } else {
              historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
            }
        } else {
          historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
        }
      } else {
        historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
      }
    });
  }

  // Determine execution parameters
  const { isScrapybaraInstance, shouldUseSDKTools, provider, capabilities } = determineInstanceCapabilities(instance, useSdkTools);
  
  const useAssistantOnly =
    instance.status === 'uninstantiated' ||
    instance.status === 'paused' ||
    instance.status === 'stopped' ||
    instance.status === 'error' ||
    (instance.status === 'running' && !instance.provider_instance_id);

  let baseSystemPrompt = '';
  let toolsContext = '';
  let finalProvider = provider;

  if (useAssistantOnly) {
     finalProvider = 'azure'; // Force Azure for assistant-only
     baseSystemPrompt =
        instance.status === 'paused' || instance.status === 'stopped'
          ? 'You are a helpful AI assistant. This instance is currently paused, so browser automation tools are not available.'
          : instance.status === 'error'
            ? 'You are a helpful AI assistant. Browser automation encountered an error and is not available, but you can still help with questions and advice.'
            : instance.status === 'running' && !instance.provider_instance_id
              ? 'You are a helpful AI assistant. Browser automation is still provisioning and not yet available.'
              : 'You are a helpful AI assistant. This is an uninstantiated instance without browser automation tools.';
  } else {
      if (capabilities.hasPCTools && isScrapybaraInstance) {
        baseSystemPrompt = 'You are a helpful AI assistant with access to Scrapybara browser automation tools. You can control the computer, execute commands, and edit files.';
        toolsContext = '\n\n🛠️ AVAILABLE SCRAPYBARA TOOLS:\n- computer(): Control browser, click, type, navigate, take screenshots\n- bash(): Execute shell commands and system operations\n- edit(): Edit files and manage file system\n\n💡 You have full PC management capabilities through these tools.\n\n🚨 IMPORTANT: This is a Scrapybara instance - you have access to browser automation and PC control tools.';
      } else if (capabilities.hasPCTools && !isScrapybaraInstance) {
        baseSystemPrompt = 'You are a helpful AI assistant with access to PC management tools. You can control the computer, execute commands, and edit files.';
        toolsContext = '\n\n🛠️ AVAILABLE PC MANAGEMENT TOOLS:\n- computer(): Control browser, click, type, navigate, take screenshots\n- bash(): Execute shell commands and system operations\n- edit(): Edit files and manage file system\n\n💡 You have full PC management capabilities through these tools.\n\n🚨 IMPORTANT: This is our assistant instance - you have access to PC management tools for computer control.';
      } else {
        baseSystemPrompt = 'You are a helpful AI assistant. Browser automation tools are not available in this mode.';
        toolsContext = '\n\n⚠️ NOTE: PC management tools are not available in this mode. You can only provide text-based assistance.';
      }
  }

  // Generate prompts
  const agentBackground = await generateAgentBackground(siteId);
  const memoriesContext = await fetchMemoriesContext(siteId, userId, instanceId);
  const toolsWithImageGeneration = getAssistantTools(siteId, userId, instanceId, customTools);
  const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', instanceId);

  // Instance renaming logic prompt
  const instanceName = instance.name || '';
  const genericNames = ['Assistant Session', 'New Instance', 'Untitled', 'Instance', 'Session', 'Assistant'];
  const isGenericName = genericNames.some(generic => 
    instanceName.toLowerCase().includes(generic.toLowerCase())
  );
  
  const renameInstruction = isGenericName 
    ? `\n\n⚠️ IMPORTANT: The current instance name "${instanceName}" is generic and not descriptive. You MUST automatically call the rename_instance tool to give this instance a descriptive name that reflects the user's objective and conversation context. Additionally, if the current name does not accurately summarize or reflect the conversation content, you should also call rename_instance. Do this automatically without asking the user.`
    : `\n\n💡 NOTE: If the current instance name "${instanceName}" does not accurately summarize or reflect the conversation/chat content, you should automatically call the rename_instance tool to update it with a more descriptive name.`;

  const combinedSystemPrompt = [
    agentBackground,
    baseSystemPrompt,
    toolsContext,
    systemPrompt || '',
    memoriesContext,
    historyContext,
    assetsContext,
    ICP_CATEGORY_IDS_INSTRUCTION,
    renameInstruction,
    toolsWithImageGeneration.length > 0 ? `\n\n🔧 CUSTOM TOOLS: ${toolsWithImageGeneration.length} additional tool(s)` : ''
  ].filter(Boolean).join('\n');

  // Clean base64 data
  let finalSystemPrompt = combinedSystemPrompt;
  if (combinedSystemPrompt.includes('base64')) {
    finalSystemPrompt = combinedSystemPrompt.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
  }

  // Execute
  const executionResult = await executeAssistant(message, instance, {
    use_sdk_tools: shouldUseSDKTools && !useAssistantOnly,
    provider: finalProvider,
    system_prompt: finalSystemPrompt,
    custom_tools: toolsWithImageGeneration,
    instance_id: instanceId,
    site_id: siteId,
    user_id: userId,
  });

  return {
    instance_id: instanceId,
    status: instance.status,
    message: 'Execution completed successfully',
    assistant_response: executionResult.text,
    output: executionResult.output,
    usage: executionResult.usage,
  };
}
