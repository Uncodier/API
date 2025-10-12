import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';
import { connectToInstance } from '@/lib/services/robot-plan-execution/instance-connector';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/assistant
// Assistant route that works with or without Scrapybara provisioning
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minute

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
      
      // Build system prompt for new instance (simple context)
      const baseSystemPrompt = 'You are a helpful AI assistant.';
      const combinedSystemPrompt = system_prompt 
        ? `${baseSystemPrompt}\n\n${system_prompt}` 
        : baseSystemPrompt;
      
      const result = await executeAssistant(message, null, {
        use_sdk_tools: false, // Never use SDK tools for uninstantiated
        provider: provider,
        system_prompt: combinedSystemPrompt,
        custom_tools: customTools,
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
      .select('log_type, message, created_at')
      .eq('instance_id', providedInstanceId)
      .in('log_type', ['user_action', 'agent_action', 'execution_summary'])
      .order('created_at', { ascending: true })
      .limit(10);

    // Build context from historical logs
    let historyContext = '';
    if (historicalLogs && historicalLogs.length > 0) {
      historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
      historicalLogs.forEach((log, index) => {
        const timestamp = new Date(log.created_at).toLocaleTimeString();
        const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
        historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
      });
    }

    // Determine execution mode based on instance status
    let executionResult;

    if (instance.status === 'uninstantiated' || instance.status === 'paused') {
      // Execute without Scrapybara tools (treat paused as uninstantiated for assistant)
      const statusType = instance.status === 'paused' ? 'paused' : 'uninstantiated';
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is ${statusType}, using OpenAI assistant without tools`);
      
      const providerEnv = process.env.ROBOT_SDK_PROVIDER;
      const provider = (providerEnv === 'scrapybara' || providerEnv === 'azure' || providerEnv === 'openai') 
        ? providerEnv 
        : 'azure';
      
      // Build system prompt for uninstantiated/paused instance
      const baseSystemPrompt = instance.status === 'paused' 
        ? 'You are a helpful AI assistant. This instance is currently paused, so browser automation tools are not available.'
        : 'You are a helpful AI assistant. This is an uninstantiated instance without browser automation tools.';
      
      const combinedSystemPrompt = [
        baseSystemPrompt,
        system_prompt || '',
        historyContext,
        customTools.length > 0 ? `\n\n🛠️ AVAILABLE TOOLS: ${customTools.length} custom tool(s)` : ''
      ].filter(Boolean).join('\n');
      
      executionResult = await executeAssistant(message, instance, {
        use_sdk_tools: false,
        provider: provider,
        system_prompt: combinedSystemPrompt,
        custom_tools: customTools,
        instance_id: providedInstanceId,
        site_id: site_id,
        user_id: user_id,
      });
    } else if (instance.status === 'running' && instance.provider_instance_id) {
      // Execute with Scrapybara tools if requested
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is running, using SDK tools: ${use_sdk_tools}`);
      
      const providerEnv = process.env.ROBOT_SDK_PROVIDER;
      const provider = (providerEnv === 'scrapybara' || providerEnv === 'azure' || providerEnv === 'openai') 
        ? providerEnv 
        : 'scrapybara';
      
      // Build system prompt for running instance with tools
      const baseSystemPrompt = use_sdk_tools 
        ? 'You are a helpful AI assistant with access to browser automation tools (computer, bash, edit).'
        : 'You are a helpful AI assistant.';
      
      const toolsContext = use_sdk_tools 
        ? '\n\n🛠️ AVAILABLE SCRAPYBARA TOOLS:\n- computer(): Control browser, click, type, navigate\n- bash(): Execute shell commands\n- edit(): Edit files' 
        : '';
      
      const combinedSystemPrompt = [
        baseSystemPrompt,
        toolsContext,
        system_prompt || '',
        historyContext,
        customTools.length > 0 ? `\n\n🔧 CUSTOM TOOLS: ${customTools.length} additional tool(s)` : ''
      ].filter(Boolean).join('\n');
      
      executionResult = await executeAssistant(message, instance, {
        use_sdk_tools: use_sdk_tools,
        provider: provider,
        system_prompt: combinedSystemPrompt,
        custom_tools: customTools,
        instance_id: providedInstanceId,
        site_id: site_id,
        user_id: user_id,
      });
    } else {
      return NextResponse.json(
        {
          error: 'Instance is not in a valid state for execution',
          status: instance.status,
          message: 'Instance must be uninstantiated, paused, or running',
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

