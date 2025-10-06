/**
 * Execution Logger Service
 * Handles logging of execution summary
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { extractStructuredResponse } from './response-parser';

/**
 * Save execution summary log
 */
export async function saveExecutionSummary(
  currentStep: any,
  finalResult: string,
  executionResult: any,
  executionStartTime: number,
  stepResult: string,
  stepStatus: string,
  remoteInstance: any,
  effective_plan_id: string,
  plan: any,
  instance_id: string
) {
  const { text, output } = executionResult;
  
  let finalLogMessage = finalResult;
  if (output && output.event && output.assistant_message) {
    finalLogMessage = output.assistant_message.trim();
  } else if (text) {
    const finalStructuredResponse = extractStructuredResponse(text);
    if (finalStructuredResponse && finalStructuredResponse.assistant_message) {
      finalLogMessage = finalStructuredResponse.assistant_message.trim();
    } else {
      finalLogMessage = finalResult.substring(0, 1000);
    }
  }
  
  await supabaseAdmin.from('instance_logs').insert({
    log_type: 'execution_summary',
    level: 'info',
    message: `Step ${currentStep.order} execution completed: ${finalLogMessage.substring(0, 200)}`,
    step_id: `step_${currentStep.order}`,
    tokens_used: executionResult.usage ? {
      promptTokens: executionResult.usage.promptTokens || executionResult.usage.input_tokens,
      completionTokens: executionResult.usage.completionTokens || executionResult.usage.output_tokens,
      totalTokens: executionResult.usage.totalTokens || executionResult.usage.total_tokens || 
                    (executionResult.usage.input_tokens + executionResult.usage.output_tokens),
    } : {},
    duration_ms: Math.round(Date.now() - executionStartTime),
    details: {
      final_text: text,
      total_steps: executionResult.steps?.length || 0,
      remote_instance_id: remoteInstance.id,
      plan_id: effective_plan_id,
      plan_title: plan.title,
      plan_status: stepStatus,
      detected_result: stepResult,
    },
    instance_id: instance_id,
    site_id: plan.site_id,
    user_id: plan.user_id,
    agent_id: plan.agent_id,
    command_id: plan.command_id,
  });
}
