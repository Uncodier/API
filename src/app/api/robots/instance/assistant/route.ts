'use workflow';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
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

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/assistant
// Assistant route that works with or without Scrapybara provisioning
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutes - maximum for Vercel Pro plan, allows for longer Scrapybara SDK streaming operations

const AssistantSchema = z.object({
  instance_id: z.string().uuid('instance_id must be valid UUID').optional(),
  message: z.string().min(1, 'message is required'),
  site_id: z.string().min(1, 'site_id is required when creating new instance').optional(),
  user_id: z.string().uuid().optional(),
  tools: z.array(z.any()).optional().default([]),
  use_sdk_tools: z.boolean().optional().default(false),
  system_prompt: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    console.log('🔍 Raw body received:', JSON.stringify(rawBody, null, 2));
    
    const {
      instance_id: providedInstanceId,
      message,
      site_id: providedSiteId,
      user_id: providedUserId,
      tools: customTools,
      use_sdk_tools,
      system_prompt,
    } = AssistantSchema.parse(rawBody);

    // CASE 1: No instance_id provided - Create new uninstantiated instance
    if (!providedInstanceId) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Creating new uninstantiated instance`);

      if (!providedSiteId) {
        return NextResponse.json(
          { error: 'site_id is required when creating new instance' },
          { status: 400 }
        );
      }

      // Get site info to get user_id
      const { data: site, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('user_id')
        .eq('id', providedSiteId)
        .single();

      if (siteError || !site) {
        return NextResponse.json({ error: 'Site not found' }, { status: 404 });
      }

      const userId = providedUserId || site.user_id;

      // Create uninstantiated instance
      const { data: newInstance, error: instanceError } = await supabaseAdmin
        .from('remote_instances')
        .insert({
          name: 'Assistant Session',
          instance_type: 'ubuntu',
          status: 'uninstantiated',
          site_id: providedSiteId,
          user_id: userId,
          created_by: userId,
          timeout_hours: 1,
        })
        .select()
        .single();

      if (instanceError || !newInstance) {
        console.error('Error creating instance:', instanceError);
        return NextResponse.json(
          { error: 'Failed to create instance', details: instanceError },
          { status: 500 }
        );
      }

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Created uninstantiated instance: ${newInstance.id}`);

      // Log user prompt
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'user_action',
        level: 'info',
        message: message,
        details: {
          prompt_source: 'assistant_route',
          is_creation: true,
        },
        instance_id: newInstance.id,
        site_id: providedSiteId,
        user_id: userId,
      });

      // Execute assistant without Scrapybara tools
      const providerEnv = process.env.ROBOT_SDK_PROVIDER;
      const provider = (providerEnv === 'scrapybara' || providerEnv === 'azure' || providerEnv === 'openai') 
        ? providerEnv 
        : 'azure';
      
      // Generate agent background and memories context
      const agentBackground = await generateAgentBackground(providedSiteId);
      const memoriesContext = await fetchMemoriesContext(providedSiteId, userId, newInstance.id);

      // Get all tools including custom ones
      const toolsWithImageGeneration = getAssistantTools(providedSiteId, userId, newInstance.id, customTools);
      
      // Build system prompt for new instance (simple context)
      const baseSystemPrompt = 'You are a helpful AI assistant.';
      const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', newInstance.id);
      
      // Check if instance name is generic and add instruction to rename
      const instanceName = newInstance.name || '';
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
        system_prompt || '',
        memoriesContext,
        assetsContext,
        ICP_CATEGORY_IDS_INSTRUCTION,
        renameInstruction
      ].filter(Boolean).join('\n\n');
      
      const result = await executeAssistant(message, null, {
        use_sdk_tools: false, // Never use SDK tools for uninstantiated
        provider: provider,
        system_prompt: combinedSystemPrompt,
        custom_tools: toolsWithImageGeneration,
        instance_id: newInstance.id,
        site_id: providedSiteId,
        user_id: userId,
      });

      return NextResponse.json({
        data: {
          instance_id: newInstance.id,
          status: 'uninstantiated',
          message: 'Instance created successfully',
          assistant_response: result.text,
          output: result.output,
          usage: result.usage,
        },
      }, { status: 200 });
    }

    // CASE 2: Existing instance_id provided - Execute on existing instance
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing on existing instance: ${providedInstanceId}`);

    // Get instance
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', providedInstanceId)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    const site_id = providedSiteId || instance.site_id;
    const user_id = providedUserId || instance.user_id;

    // Log user prompt
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user_action',
      level: 'info',
      message: message,
      details: {
        prompt_source: 'assistant_route',
        instance_status: instance.status,
      },
      instance_id: providedInstanceId,
      site_id: site_id,
      user_id: user_id,
    });

    // Get historical logs for context
    const { data: historicalLogs } = await supabaseAdmin
      .from('instance_logs')
      .select('log_type, message, created_at, tool_name, tool_result')
      .eq('instance_id', providedInstanceId)
      .in('log_type', ['user_action', 'agent_action', 'execution_summary', 'tool_call'])
      .order('created_at', { ascending: true })
      .limit(500);

    // Build context from historical logs
    let historyContext = '';
    if (historicalLogs && historicalLogs.length > 0) {
      historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
      historicalLogs.forEach((log, index) => {
        const timestamp = new Date(log.created_at).toLocaleTimeString();
        const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
        
        // Handle tool calls with special formatting
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

    // Determine execution mode based on instance status
    let executionResult;

    const useAssistantOnly =
      instance.status === 'uninstantiated' ||
      instance.status === 'paused' ||
      instance.status === 'stopped' ||
      instance.status === 'error' ||
      (instance.status === 'running' && !instance.provider_instance_id);

    if (useAssistantOnly) {
      const statusType =
        instance.status === 'paused' || instance.status === 'stopped'
          ? 'paused'
          : instance.status === 'error'
            ? 'error'
            : instance.status === 'running' && !instance.provider_instance_id
              ? 'running (no provider)'
              : 'uninstantiated';
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is ${statusType}, using OpenAI assistant without tools`);
      
      const provider = 'azure';
      
      const agentBackground = await generateAgentBackground(site_id);
      const memoriesContext = await fetchMemoriesContext(site_id, user_id, providedInstanceId);
      const toolsWithImageGeneration = getAssistantTools(site_id, user_id, providedInstanceId, customTools);
      
      const baseSystemPrompt =
        instance.status === 'paused' || instance.status === 'stopped'
          ? 'You are a helpful AI assistant. This instance is currently paused, so browser automation tools are not available.'
          : instance.status === 'error'
            ? 'You are a helpful AI assistant. Browser automation encountered an error and is not available, but you can still help with questions and advice.'
            : instance.status === 'running' && !instance.provider_instance_id
              ? 'You are a helpful AI assistant. Browser automation is still provisioning and not yet available.'
              : 'You are a helpful AI assistant. This is an uninstantiated instance without browser automation tools.';
      
      const instanceName = instance.name || '';
      const genericNames = ['Assistant Session', 'New Instance', 'Untitled', 'Instance', 'Session', 'Assistant'];
      const isGenericName = genericNames.some(generic => 
        instanceName.toLowerCase().includes(generic.toLowerCase())
      );
      
      const renameInstruction = isGenericName 
        ? `\n\n⚠️ IMPORTANT: The current instance name "${instanceName}" is generic and not descriptive. You MUST automatically call the rename_instance tool to give this instance a descriptive name that reflects the user's objective and conversation context. Additionally, if the current name does not accurately summarize or reflect the conversation content, you should also call rename_instance. Do this automatically without asking the user.`
        : `\n\n💡 NOTE: If the current instance name "${instanceName}" does not accurately summarize or reflect the conversation/chat content, you should automatically call the rename_instance tool to update it with a more descriptive name.`;
      
      const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', providedInstanceId);
      const combinedSystemPrompt = [
        agentBackground,
        baseSystemPrompt,
        system_prompt || '',
        memoriesContext,
        historyContext,
        assetsContext,
        ICP_CATEGORY_IDS_INSTRUCTION,
        renameInstruction,
        toolsWithImageGeneration.length > 0 ? `\n\n🛠️ AVAILABLE TOOLS: ${toolsWithImageGeneration.length} custom tool(s)` : ''
      ].filter(Boolean).join('\n');
      
      executionResult = await executeAssistant(message, instance, {
        use_sdk_tools: false,
        provider: provider,
        system_prompt: combinedSystemPrompt,
        custom_tools: toolsWithImageGeneration,
        instance_id: providedInstanceId,
        site_id: site_id,
        user_id: user_id,
      });
    } else if (instance.status === 'running' && instance.provider_instance_id) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is running, determining tool availability`);
      
      const { isScrapybaraInstance, shouldUseSDKTools, provider, capabilities } = determineInstanceCapabilities(instance, use_sdk_tools);
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Provider: ${provider}, Is Scrapybara: ${isScrapybaraInstance}, Use SDK tools: ${shouldUseSDKTools}`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Capabilities:`, capabilities);
      
      let baseSystemPrompt: string;
      let toolsContext: string;
      
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
      
      const agentBackground = await generateAgentBackground(site_id);
      const memoriesContext = await fetchMemoriesContext(site_id, user_id, providedInstanceId);
      const toolsWithImageGeneration = getAssistantTools(site_id, user_id, providedInstanceId, customTools);
      
      const instanceName = instance.name || '';
      const genericNames = ['Assistant Session', 'New Instance', 'Untitled', 'Instance', 'Session', 'Assistant'];
      const isGenericName = genericNames.some(generic => 
        instanceName.toLowerCase().includes(generic.toLowerCase())
      );
      
      const renameInstruction = isGenericName 
        ? `\n\n⚠️ IMPORTANT: The current instance name "${instanceName}" is generic and not descriptive. You MUST automatically call the rename_instance tool to give this instance a descriptive name that reflects the user's objective and conversation context. Additionally, if the current name does not accurately summarize or reflect the conversation content, you should also call rename_instance. Do this automatically without asking the user.`
        : `\n\n💡 NOTE: If the current instance name "${instanceName}" does not accurately summarize or reflect the conversation/chat content, you should automatically call the rename_instance tool to update it with a more descriptive name.`;
      
      const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', providedInstanceId);
      const combinedSystemPrompt = [
        agentBackground,
        baseSystemPrompt,
        toolsContext,
        system_prompt || '',
        memoriesContext,
        historyContext,
        assetsContext,
        ICP_CATEGORY_IDS_INSTRUCTION,
        renameInstruction,
        toolsWithImageGeneration.length > 0 ? `\n\n🔧 CUSTOM TOOLS: ${toolsWithImageGeneration.length} additional tool(s)` : ''
      ].filter(Boolean).join('\n');
      
      // Clean base64 data from system prompt if present
      let finalSystemPrompt = combinedSystemPrompt;
      if (combinedSystemPrompt.includes('base64')) {
        finalSystemPrompt = combinedSystemPrompt.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
      }
      
      executionResult = await executeAssistant(message, instance, {
        use_sdk_tools: shouldUseSDKTools,
        provider: provider,
        system_prompt: finalSystemPrompt,
        custom_tools: toolsWithImageGeneration,
        instance_id: providedInstanceId,
        site_id: site_id,
        user_id: user_id,
      });
    } else {
      console.error(`❌ [Assistant] Instance invalid state for execution:`, {
        instance_id: providedInstanceId,
        status: instance.status,
        provider_instance_id: instance.provider_instance_id,
        message: 'Instance must be uninstantiated, paused, stopped, or running',
      });
      return NextResponse.json(
        {
          error: 'Instance is not in a valid state for execution',
          status: instance.status,
          message: 'Instance must be uninstantiated, paused, stopped, running, or error',
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      data: {
        instance_id: providedInstanceId,
        status: instance.status,
        message: 'Execution completed successfully',
        assistant_response: executionResult.text,
        output: executionResult.output,
        usage: executionResult.usage,
      },
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error in POST /robots/instance/assistant:', err);
    
    return NextResponse.json({
      error: err.message || 'Failed to execute assistant',
      details: err.stack,
    }, { status: 500 });
  }
}
