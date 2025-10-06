/**
 * Step Execution Handler Service
 * Handles onStep callbacks, logging, and structured response processing
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { extractStructuredResponse } from './response-parser';

/**
 * Create onStep callback handler for agent execution
 */
export function createOnStepHandler(
  remoteInstance: any,
  currentStep: any,
  effective_plan_id: string,
  plan: any,
  instance_id: string,
  stepStatusRef: { value: string },
  stepResultRef: { value: string }
) {
  return async (step: any) => {
    // ✓ CRITICAL: Check if plan has been paused/stopped before processing step
    const { data: planStatus, error: statusError } = await supabaseAdmin
      .from('instance_plans')
      .select('status')
      .eq('id', effective_plan_id)
      .single();

    if (!statusError && planStatus) {
      if (planStatus.status === 'pending' || planStatus.status === 'paused' || planStatus.status === 'stopped') {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Plan has been paused/stopped (status: ${planStatus.status}), terminating execution`);
        stepStatusRef.value = 'paused';
        stepResultRef.value = `Execution paused by user (plan status: ${planStatus.status})`;
        throw new Error(`PLAN_PAUSED: Execution terminated because plan status changed to ${planStatus.status}`);
      }
    }

    // Check instance status as well
    const { data: instanceStatus, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('status')
      .eq('id', instance_id)
      .single();

    if (!instanceError && instanceStatus) {
      if (instanceStatus.status !== 'running') {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Instance is no longer running (status: ${instanceStatus.status}), terminating execution`);
        stepStatusRef.value = 'paused';
        stepResultRef.value = `Execution stopped because instance status changed to ${instanceStatus.status}`;
        throw new Error(`INSTANCE_STOPPED: Execution terminated because instance status changed to ${instanceStatus.status}`);
      }
    }
    
    // Handle step following Python pattern - with more detail
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP] Instance: ${remoteInstance.id}`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP] Text: ${step.text}`);
    if (step.toolCalls?.length > 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP] Tool calls: ${step.toolCalls.length}`);
    }
    
    // Detect structured response - prioritize schema output if exists
    let structuredResponse = null;
    
    // 1. Try using structured output from schema first
    if (step.output && step.output.event && typeof step.output.step === 'number' && step.output.assistant_message) {
      structuredResponse = step.output;
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP STRUCTURED] Using schema output: ${structuredResponse.event}`);
    }
    // 2. Fallback to manual extraction from text
    else if (step.text) {
      structuredResponse = extractStructuredResponse(step.text);
      if (structuredResponse) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP FALLBACK] Using manual extraction: ${structuredResponse.event}`);
      }
    }
    
    if (structuredResponse) {
      // Validate step number matches
      if (structuredResponse.step === currentStep.order) {
        stepResultRef.value = structuredResponse.assistant_message;
        
        // Map events to internal states
        switch (structuredResponse.event) {
          case 'step_completed':
            stepStatusRef.value = 'completed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step ${structuredResponse.step} completed: ${structuredResponse.assistant_message}`);
            break;
          case 'step_failed':
            stepStatusRef.value = 'failed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step ${structuredResponse.step} failed: ${structuredResponse.assistant_message}`);
            break;
          case 'step_canceled':
            stepStatusRef.value = 'canceled';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step ${structuredResponse.step} canceled: ${structuredResponse.assistant_message}`);
            break;
          case 'plan_failed':
            stepStatusRef.value = 'plan_failed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Plan failed: ${structuredResponse.assistant_message}`);
            break;
          case 'plan_new_required':
            stepStatusRef.value = 'new_plan_required';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] New plan required: ${structuredResponse.assistant_message}`);
            break;
          case 'session_acquired':
            stepStatusRef.value = 'new_session';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Session acquired: ${structuredResponse.assistant_message}`);
            break;
          case 'session_needed':
            stepStatusRef.value = 'session_needed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Session needed: ${structuredResponse.assistant_message}`);
            break;
          case 'session_saved':
            stepStatusRef.value = 'completed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Session saved: ${structuredResponse.assistant_message}`);
            break;
          case 'user_attention_required':
            stepStatusRef.value = 'user_attention_required';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] User attention required: ${structuredResponse.assistant_message}`);
            break;
          default:
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Unknown event type: ${structuredResponse.event}`);
        }
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step number mismatch: expected ${currentStep.order}, got ${structuredResponse.step}`);
      }
    } else {
      // Fallback to regex patterns for compatibility
      const stepNumberPattern = new RegExp(`step\\s+${currentStep.order}\\s+(finished|failed|canceled)`, 'i');
      const stepMatch = step.text.match(stepNumberPattern);
      
      if (stepMatch) {
        const detectedStatus = stepMatch[1].toLowerCase();
        stepResultRef.value = step.text;
        switch (detectedStatus) {
          case 'finished':
            stepStatusRef.value = 'completed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step completion detected: ${step.text}`);
            break;
          case 'failed':
            stepStatusRef.value = 'failed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step failed detected: ${step.text}`);
            break;
          case 'canceled':
            stepStatusRef.value = 'canceled';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step canceled detected: ${step.text}`);
            break;
        }
      }
    }
    
    // Show tool calls like in Python
    if (step.toolCalls) {
      for (const call of step.toolCalls) {
        const args = Object.entries(call.args || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        console.log(`${call.toolName} [${remoteInstance.id}] → ${args}`);
      }
    }

    // Save to DB with reference to plan step
    // PRIORITY: Always extract assistant_message from structured output
    let logMessage = 'Executing plan step';
    let stepStructuredResponse = null;
    
    // 1. Priority: Structured output from Zod schema
    if (step.output && step.output.event && step.output.assistant_message) {
      stepStructuredResponse = step.output;
      logMessage = step.output.assistant_message.trim();
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT_MESSAGE] From schema: ${logMessage.substring(0, 100)}...`);
    } 
    // 2. Fallback: Manual extraction from text
    else if (step.text) {
      stepStructuredResponse = extractStructuredResponse(step.text);
      if (stepStructuredResponse && stepStructuredResponse.assistant_message) {
        logMessage = stepStructuredResponse.assistant_message.trim();
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT_MESSAGE] From extraction: ${logMessage.substring(0, 100)}...`);
      } else {
        // If no structured response, use text but limited
        logMessage = step.text.trim().substring(0, 500) || 'Executing plan step';
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT_MESSAGE] Fallback to text: ${logMessage.substring(0, 100)}...`);
      }
    }
    
    // First create a parent log for the step
    const { data: parentLogData, error: parentLogError } = await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_action',
      level: 'info',
      message: logMessage,
      step_id: `step_${currentStep.order}`,
      tokens_used: step.usage ? {
        promptTokens: step.usage.promptTokens || step.usage.input_tokens,
        completionTokens: step.usage.completionTokens || step.usage.output_tokens,
        totalTokens: step.usage.totalTokens || (step.usage.input_tokens + step.usage.output_tokens),
      } : {},
      details: {
        remote_instance_id: remoteInstance.id,
        plan_id: effective_plan_id,
        plan_title: plan.title,
        detected_status: stepStatusRef.value,
        structured_response: stepStructuredResponse,
        raw_text: step.text,
        total_tool_calls: step.toolCalls?.length || 0,
      },
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    }).select().single();
    
    if (parentLogError) {
      console.error('❌ Error saving parent log:', parentLogError);
    }
    
    const parentLogId = parentLogData?.id;
    
    // Then create individual logs for each tool call, linked to parent
    if (step.toolCalls && step.toolCalls.length > 0 && parentLogId) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Saving ${step.toolCalls.length} tool calls to database...`);
      let savedToolCalls = 0;
      let failedToolCalls = 0;
      
      for (const toolCall of step.toolCalls) {
        // Find corresponding result
        const toolResult = step.toolResults?.find((result: any) => 
          result.toolCallId === toolCall.id || result.toolCallId === toolCall.toolCallId
        );
        
        // Extract base64 image - now comes directly in toolResult.base64Image
        let screenshotBase64 = null;
        if (toolResult) {
          screenshotBase64 = toolResult.base64Image || null;
          
          // Debug: Only if we don't find image where expected
          if (!screenshotBase64 && toolCall.toolName === 'computer') {
            console.log(`⚠️ [SCREENSHOT_MISSING] Tool: ${toolCall.toolName}, toolResult keys:`, Object.keys(toolResult));
          }
        }
        
        const { error: toolLogError } = await supabaseAdmin.from('instance_logs').insert({
          log_type: 'tool_call',
          level: 'info',
          message: `${toolCall.toolName}: ${toolCall.args ? Object.entries(toolCall.args).map(([k, v]) => `${k}=${v}`).join(', ') : 'no args'}`,
          step_id: `step_${currentStep.order}`,
          tool_name: toolCall.toolName,
          tool_call_id: toolCall.id || toolCall.toolCallId,
          tool_args: toolCall.args || {},
          tool_result: toolResult ? {
            success: !toolResult.isError,
            output: (() => {
              // Clean output of any base64 image
              const rawOutput = toolResult.result || toolResult.content || '';
              if (typeof rawOutput === 'string') {
                // If string contains base64, extract only useful text
                if (rawOutput.includes('base64,')) {
                  return 'Screenshot captured successfully'; // Clean text instead of base64
                }
                return rawOutput;
              }
              // If object, remove any base64Image field
              if (typeof rawOutput === 'object' && rawOutput !== null) {
                const cleanOutput = { ...rawOutput };
                delete cleanOutput.base64Image;
                return cleanOutput;
              }
              return rawOutput;
            })(),
            error: toolResult.isError ? (toolResult.error || toolResult.result) : null,
            // ❌ NO include any base64 reference here
          } : {},
          screenshot_base64: screenshotBase64, // ✅ Only here
          parent_log_id: parentLogId, // 🔗 Link to main log
          duration_ms: step.usage?.duration_ms || null,
          tokens_used: step.usage ? {
            promptTokens: step.usage.promptTokens || step.usage.input_tokens,
            completionTokens: step.usage.completionTokens || step.usage.output_tokens,
            totalTokens: step.usage.totalTokens || (step.usage.input_tokens + step.usage.output_tokens),
          } : {},
          details: {
            remote_instance_id: remoteInstance.id,
            plan_id: effective_plan_id,
            plan_title: plan.title,
            detected_status: stepStatusRef.value,
            tool_sequence_number: step.toolCalls.indexOf(toolCall) + 1,
            total_tool_calls: step.toolCalls.length,
          },
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
        
        if (toolLogError) {
          console.error(`❌ Error saving tool log for ${toolCall.toolName}:`, toolLogError);
          failedToolCalls++;
        } else {
          savedToolCalls++;
        }
      }
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Tool calls saved: ${savedToolCalls}/${step.toolCalls.length} (${failedToolCalls} failed)`);
    } else if (step.toolCalls && step.toolCalls.length > 0 && !parentLogId) {
      console.warn(`⚠️ Cannot save ${step.toolCalls.length} tool calls - no parent log ID (parent log insert failed)`);
    }
  };
}
