/**
 * Example Usage of Custom Azure OpenAI + Scrapybara Implementation
 * 
 * This file demonstrates how to replace Scrapybara's SDK with the custom
 * Azure OpenAI-based implementation in your route handlers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { OpenAIAgentExecutor } from './openai-agent-executor';
import { ScrapybaraInstanceManager } from './scrapybara-instance-manager';
import { createScrapybaraTools } from './scrapybara-tools';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Define response schema (same as before)
const AgentResponseSchema = z.object({
  event: z.enum([
    'step_completed',
    'step_failed',
    'step_canceled',
    'plan_failed',
    'plan_new_required',
    'session_acquired',
    'session_needed',
    'session_saved',
    'user_attention_required',
  ]),
  step: z.number(),
  assistant_message: z.string(),
});

/**
 * Example: Replace Scrapybara SDK in your existing route
 * 
 * BEFORE (with Scrapybara SDK):
 * ```
 * import { ScrapybaraClient } from 'scrapybara';
 * import { anthropic } from 'scrapybara/anthropic';
 * import { bashTool, computerTool, editTool } from 'scrapybara/tools';
 * 
 * const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY });
 * const instance = await client.get(provider_instance_id);
 * const result = await client.act({
 *   model: anthropic(),
 *   tools: [bashTool(instance), computerTool(instance), editTool(instance)],
 *   system: systemPrompt,
 *   prompt: userPrompt,
 *   schema: AgentResponseSchema,
 *   onStep: handleStep,
 * });
 * ```
 * 
 * AFTER (with custom Azure OpenAI implementation):
 */
export async function executeAgentWithOpenAI(
  provider_instance_id: string,
  systemPrompt: string,
  userPrompt: string,
  onStep?: (step: any) => Promise<void>
) {
  // 1. Initialize managers
  const instanceManager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);
  const executor = new OpenAIAgentExecutor({
    endpoint: process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.MICROSOFT_AZURE_OPENAI_API_KEY,
    deployment: process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
  });

  // 2. Get existing instance
  const instance = await instanceManager.getInstance(provider_instance_id);
  console.log(`Connected to instance: ${instance.id}`);

  // 3. Create tools
  const tools = createScrapybaraTools(instance);

  // 4. Execute agent with Azure OpenAI
  const result = await executor.act({
    // model is optional - uses deployment from constructor if not specified
    tools,
    system: systemPrompt,
    prompt: userPrompt,
    schema: AgentResponseSchema,
    onStep: onStep,
    maxIterations: 50,
    temperature: 1, // Azure OpenAI default (0.7 not supported on all models)
    reasoningEffort: 'low', // For o-series models (o1, o3, GPT-5.2): 'low' | 'medium' | 'high'
    verbosity: 'low', // For o-series models - output verbosity: 'low' | 'medium' | 'high'
  });

  return result;
}

/**
 * Example: Complete route handler replacement
 */
export async function POST(request: NextRequest) {
  try {
    const { instance_plan_id, provider_instance_id, step_id } = await request.json();

    // Fetch plan and step details from database
    const { data: plan } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('id', instance_plan_id)
      .single();

    const { data: currentStep } = await supabaseAdmin
      .from('instance_plan_steps')
      .select('*')
      .eq('id', step_id)
      .single();

    if (!plan || !currentStep) {
      return NextResponse.json({ error: 'Plan or step not found' }, { status: 404 });
    }

    // Build system prompt
    const systemPrompt = `You are an AI assistant that helps automate tasks.
    
Current date: ${new Date().toLocaleDateString()}

You must provide structured responses using this exact format:
{
  "event": "step_completed" | "step_failed" | "session_needed",
  "step": ${currentStep.order},
  "assistant_message": "Description of what was done"
}`;

    // Build user prompt
    const userPrompt = `Execute the following step:

Step ${currentStep.order}: ${currentStep.title}
Description: ${currentStep.description}

Complete this step and provide a structured response.`;

    // Define step handler
    const handleStep = async (step: any) => {
      console.log(`Step text: ${step.text}`);
      
      // Log to database
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'agent_action',
        level: 'info',
        message: step.text,
        step_id: `step_${currentStep.order}`,
        tokens_used: step.usage,
        details: {
          remote_instance_id: provider_instance_id,
          plan_id: instance_plan_id,
          tool_calls: step.toolCalls?.length || 0,
        },
      });

      // Handle tool calls
      if (step.toolCalls) {
        for (const call of step.toolCalls) {
          console.log(`Tool: ${call.toolName}`);
          
          // Log tool call
          await supabaseAdmin.from('instance_logs').insert({
            log_type: 'tool_call',
            level: 'info',
            message: `${call.toolName}`,
            step_id: `step_${currentStep.order}`,
            details: {
              tool_name: call.toolName,
              args: call.args,
            },
          });
        }
      }

      // Handle tool results
      if (step.toolResults) {
        for (const result of step.toolResults) {
          console.log(`Result: ${result.result}`);
          
          // Log tool result
          await supabaseAdmin.from('instance_logs').insert({
            log_type: 'tool_result',
            level: result.isError ? 'error' : 'info',
            message: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
            step_id: `step_${currentStep.order}`,
            details: {
              tool_name: result.toolName,
              is_error: result.isError,
            },
          });
        }
      }
    };

    // Execute agent
    const result = await executeAgentWithOpenAI(
      provider_instance_id,
      systemPrompt,
      userPrompt,
      handleStep
    );

    // Process result
    const output = result.output;
    
    if (!output) {
      return NextResponse.json({
        error: 'No structured output received',
      }, { status: 500 });
    }

    // Update step status based on event
    let stepStatus = 'in_progress';
    switch (output.event) {
      case 'step_completed':
        stepStatus = 'completed';
        break;
      case 'step_failed':
        stepStatus = 'failed';
        break;
      case 'session_needed':
        stepStatus = 'blocked';
        break;
    }

    // Update step in database
    await supabaseAdmin
      .from('instance_plan_steps')
      .update({
        status: stepStatus,
        result: output.assistant_message,
        completed_at: stepStatus === 'completed' ? new Date().toISOString() : null,
      })
      .eq('id', step_id);

    return NextResponse.json({
      success: true,
      event: output.event,
      message: output.assistant_message,
      step_status: stepStatus,
      tokens_used: result.usage.totalTokens,
    });

  } catch (error: any) {
    console.error('Error executing agent:', error);
    return NextResponse.json({
      error: 'Failed to execute agent',
      details: error.message,
    }, { status: 500 });
  }
}

/**
 * Example: Starting a new instance with custom implementation
 */
export async function startNewInstance(site_id: string, activity: string) {
  const manager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);

  // Start Ubuntu instance
  const instance = await manager.startUbuntu({ timeoutHours: 2 });
  console.log(`Started instance: ${instance.id}`);

  // Start browser
  const browserResult = await manager.startBrowserInInstance(instance.id);
  console.log(`Browser CDP URL: ${browserResult.cdpUrl}`);

  // Save to database
  await supabaseAdmin.from('remote_instances').insert({
    provider_instance_id: instance.id,
    site_id,
    name: activity,
    status: 'running',
    cdp_url: browserResult.cdpUrl,
    created_at: new Date().toISOString(),
  });

  return {
    instance_id: instance.id,
    cdp_url: browserResult.cdpUrl,
    status: 'running',
  };
}

/**
 * Example: Stopping an instance
 */
export async function stopExistingInstance(provider_instance_id: string) {
  const manager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);
  
  await manager.stopInstance(provider_instance_id);
  console.log(`Stopped instance: ${provider_instance_id}`);

  // Update database
  await supabaseAdmin
    .from('remote_instances')
    .update({
      status: 'stopped',
      stopped_at: new Date().toISOString(),
    })
    .eq('provider_instance_id', provider_instance_id);
}

/**
 * Example: Managing authentication
 */
export async function saveAndApplyAuth(
  provider_instance_id: string,
  sessionName: string
) {
  const manager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);

  // Save current browser state as auth
  const authSession = await manager.saveBrowserAuth(provider_instance_id, sessionName);
  console.log(`Saved auth: ${authSession.authStateId}`);

  // Save to database
  await supabaseAdmin.from('browser_auth_sessions').insert({
    auth_state_id: authSession.authStateId,
    name: authSession.name,
    domain: authSession.domain,
    provider_instance_id,
    created_at: new Date().toISOString(),
  });

  return authSession;
}

export async function applyExistingAuth(
  provider_instance_id: string,
  auth_state_id: string
) {
  const manager = new ScrapybaraInstanceManager(process.env.SCRAPYBARA_API_KEY);
  
  await manager.authenticateBrowser(provider_instance_id, auth_state_id);
  console.log(`Applied auth: ${auth_state_id}`);
}

