import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';
import { connectToInstance } from '@/lib/services/robot-plan-execution/instance-connector';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { BackgroundBuilder } from '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder';
import { DataFetcher } from '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher';
import { generateImageTool } from '@/app/api/agents/tools/generateImage/assistantProtocol';
import { generateVideoTool } from '@/app/api/agents/tools/generateVideo/assistantProtocol';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';

/**
 * Generate agent background using BackgroundBuilder service
 */
async function generateAgentBackground(siteId: string): Promise<string> {
  try {
    console.log(`🧩 [Assistant] Generating agent background for site: ${siteId}`);
    
    // Find the Growth Robot agent for this site
    const robotAgent = await findGrowthRobotAgent(siteId);
    if (!robotAgent) {
      console.log(`⚠️ [Assistant] No Growth Robot agent found for site: ${siteId}`);
      return '';
    }
    
    console.log(`✅ [Assistant] Found Growth Robot agent: ${robotAgent.agentId}`);
    
    // Fetch agent data from database
    const { data: agentData, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('id', robotAgent.agentId)
      .single();
    
    if (agentError || !agentData) {
      console.error(`❌ [Assistant] Error fetching agent data:`, agentError);
      return '';
    }
    
    // Get site information and campaigns
    const siteInfo = await DataFetcher.getSiteInfo(siteId);
    const activeCampaigns = await DataFetcher.getActiveCampaigns(siteId);
    
    console.log(`🔍 [Assistant] Site info available: ${siteInfo ? 'YES' : 'NO'}`);
    console.log(`🔍 [Assistant] Active campaigns: ${activeCampaigns?.length || 0}`);
    
    // Generate background using BackgroundBuilder
    const background = BackgroundBuilder.buildAgentPrompt(
      agentData.id,
      agentData.name,
      agentData.description,
      agentData.capabilities || [],
      agentData.backstory,
      agentData.system_prompt,
      agentData.agent_prompt,
      siteInfo,
      activeCampaigns
    );
    
    console.log(`✅ [Assistant] Generated agent background (${background.length} characters)`);
    return background;
    
  } catch (error) {
    console.error(`❌ [Assistant] Error generating agent background:`, error);
    return '';
  }
}

/**
 * Determine the instance type and available tools based on instance data and environment
 */
function determineInstanceCapabilities(instance: any, use_sdk_tools: boolean): {
  isScrapybaraInstance: boolean;
  shouldUseSDKTools: boolean;
  provider: 'scrapybara' | 'azure' | 'openai';
  capabilities: {
    hasPCTools: boolean;
    hasBrowserAutomation: boolean;
    hasFileEditing: boolean;
    hasCommandExecution: boolean;
  };
} {
  const providerEnv = process.env.ROBOT_SDK_PROVIDER;
  const provider = (providerEnv === 'scrapybara' || providerEnv === 'azure' || providerEnv === 'openai') 
    ? providerEnv 
    : 'scrapybara';
  
  // Determine if this is a Scrapybara instance
  const isScrapybaraInstance = provider === 'scrapybara';
  const shouldUseSDKTools = use_sdk_tools || isScrapybaraInstance;
  
  // Determine capabilities based on instance type and tools
  const capabilities = {
    hasPCTools: shouldUseSDKTools && instance?.provider_instance_id,
    hasBrowserAutomation: shouldUseSDKTools && instance?.provider_instance_id,
    hasFileEditing: shouldUseSDKTools && instance?.provider_instance_id,
    hasCommandExecution: shouldUseSDKTools && instance?.provider_instance_id,
  };
  
  return {
    isScrapybaraInstance,
    shouldUseSDKTools,
    provider,
    capabilities,
  };
}

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
      
      // Generate agent background for RAG context
      const agentBackground = await generateAgentBackground(providedSiteId);
      
      // Add generateImage and generateVideo tools to custom tools
      const toolsWithImageGeneration = [
        ...customTools,
        generateImageTool(providedSiteId, newInstance.id),
        generateVideoTool(providedSiteId, newInstance.id)
      ];
      
      // Build system prompt for new instance (simple context)
      const baseSystemPrompt = 'You are a helpful AI assistant.';
      const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', newInstance.id);
      const combinedSystemPrompt = [
        agentBackground,
        baseSystemPrompt,
        system_prompt || '',
        assetsContext
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
      .limit(10);

    // Build context from historical logs
    let historyContext = '';
    if (historicalLogs && historicalLogs.length > 0) {
      historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
      historicalLogs.forEach((log, index) => {
        const timestamp = new Date(log.created_at).toLocaleTimeString();
        const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
        
        // Handle tool calls with special formatting for generate_image and generate_video
        if (log.log_type === 'tool_call' && log.tool_name && log.tool_result) {
          if (log.tool_name === 'generate_image') {
            const toolResult = log.tool_result;
            if (toolResult.success && toolResult.output && toolResult.output.images) {
              const urls = toolResult.output.images.map((img: any) => img.url).filter(Boolean);
              if (urls.length > 0) {
                historyContext += `[${timestamp}] ${role}: Generated ${log.tool_name} - URLs: ${urls.join(', ')}\n`;
              } else {
                historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
              }
            } else {
              historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
            }
          } else if (log.tool_name === 'generate_video') {
            const toolResult = log.tool_result;
            if (toolResult.success && toolResult.output && toolResult.output.videos) {
              const urls = toolResult.output.videos.map((video: any) => video.url).filter(Boolean);
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

    if (instance.status === 'uninstantiated' || instance.status === 'paused' || instance.status === 'stopped') {
      // Execute without Scrapybara tools (treat paused/stopped as uninstantiated for assistant)
      const statusType = (instance.status === 'paused' || instance.status === 'stopped') ? 'paused' : 'uninstantiated';
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is ${statusType}, using OpenAI assistant without tools`);
      
      // Force Azure when instance is not running to avoid any Scrapybara provider usage
      const provider = 'azure';
      
      // Generate agent background for RAG context
      const agentBackground = await generateAgentBackground(site_id);
      
      // Add generateImage and generateVideo tools to custom tools
      const toolsWithImageGeneration = [
        ...customTools,
        generateImageTool(site_id, providedInstanceId),
        generateVideoTool(site_id, providedInstanceId)
      ];
      
      // Build system prompt for uninstantiated/paused/stopped instance
      const baseSystemPrompt = (instance.status === 'paused' || instance.status === 'stopped')
        ? 'You are a helpful AI assistant. This instance is currently paused, so browser automation tools are not available.'
        : 'You are a helpful AI assistant. This is an uninstantiated instance without browser automation tools.';
      
      const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', providedInstanceId);
      const combinedSystemPrompt = [
        agentBackground,
        baseSystemPrompt,
        system_prompt || '',
        historyContext,
        assetsContext,
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
      // Execute with appropriate tools based on instance type
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is running, determining tool availability`);
      
      const { isScrapybaraInstance, shouldUseSDKTools, provider, capabilities } = determineInstanceCapabilities(instance, use_sdk_tools);
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Provider: ${provider}, Is Scrapybara: ${isScrapybaraInstance}, Use SDK tools: ${shouldUseSDKTools}`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Capabilities:`, capabilities);
      
      // Build system prompt based on instance type and available tools
      let baseSystemPrompt: string;
      let toolsContext: string;
      
      if (capabilities.hasPCTools && isScrapybaraInstance) {
        // Scrapybara instance with full automation tools
        baseSystemPrompt = 'You are a helpful AI assistant with access to Scrapybara browser automation tools. You can control the computer, execute commands, and edit files.';
        toolsContext = '\n\n🛠️ AVAILABLE SCRAPYBARA TOOLS:\n- computer(): Control browser, click, type, navigate, take screenshots\n- bash(): Execute shell commands and system operations\n- edit(): Edit files and manage file system\n\n💡 You have full PC management capabilities through these tools.\n\n🚨 IMPORTANT: This is a Scrapybara instance - you have access to browser automation and PC control tools.';
      } else if (capabilities.hasPCTools && !isScrapybaraInstance) {
        // Our assistant with PC management tools
        baseSystemPrompt = 'You are a helpful AI assistant with access to PC management tools. You can control the computer, execute commands, and edit files.';
        toolsContext = '\n\n🛠️ AVAILABLE PC MANAGEMENT TOOLS:\n- computer(): Control browser, click, type, navigate, take screenshots\n- bash(): Execute shell commands and system operations\n- edit(): Edit files and manage file system\n\n💡 You have full PC management capabilities through these tools.\n\n🚨 IMPORTANT: This is our assistant instance - you have access to PC management tools for computer control.';
      } else {
        // No tools available
        baseSystemPrompt = 'You are a helpful AI assistant. Browser automation tools are not available in this mode.';
        toolsContext = '\n\n⚠️ NOTE: PC management tools are not available in this mode. You can only provide text-based assistance.';
      }
      
      // Generate agent background for RAG context
      const agentBackground = await generateAgentBackground(site_id);
      
      // Add generateImage and generateVideo tools to custom tools
      const toolsWithImageGeneration = [
        ...customTools,
        generateImageTool(site_id, providedInstanceId),
        generateVideoTool(site_id, providedInstanceId)
      ];
      
      const assetsContext = await InstanceAssetsService.appendAssetsToSystemPrompt('', providedInstanceId);
      const combinedSystemPrompt = [
        agentBackground,
        baseSystemPrompt,
        toolsContext,
        system_prompt || '',
        historyContext,
        assetsContext,
        toolsWithImageGeneration.length > 0 ? `\n\n🔧 CUSTOM TOOLS: ${toolsWithImageGeneration.length} additional tool(s)` : ''
      ].filter(Boolean).join('\n');
      
      // Clean base64 data from system prompt if present
      if (combinedSystemPrompt.includes('base64')) {
        const cleanedSystemPrompt = combinedSystemPrompt.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
        executionResult = await executeAssistant(message, instance, {
          use_sdk_tools: shouldUseSDKTools,
          provider: provider,
          system_prompt: cleanedSystemPrompt,
          custom_tools: toolsWithImageGeneration,
          instance_id: providedInstanceId,
          site_id: site_id,
          user_id: user_id,
        });
      } else {
        executionResult = await executeAssistant(message, instance, {
          use_sdk_tools: shouldUseSDKTools,
          provider: provider,
          system_prompt: combinedSystemPrompt,
          custom_tools: toolsWithImageGeneration,
          instance_id: providedInstanceId,
          site_id: site_id,
          user_id: user_id,
        });
      }
    } else {
      return NextResponse.json(
        {
          error: 'Instance is not in a valid state for execution',
          status: instance.status,
          message: 'Instance must be uninstantiated, paused, stopped, or running',
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

