/**
 * Special State Handler Service
 * Handles special plan states like new_plan_required, new_session, user_attention_required, etc.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { extractNewPlanFromText } from './response-parser';
import { createNewPlanForInstance } from './plan-manager';
import { requestSessionCreation } from './session-manager';

/**
 * Handle special plan states
 */
export async function handleSpecialStates(
  stepStatus: string,
  finalResult: string,
  currentStep: any,
  instance_id: string,
  effective_plan_id: string,
  plan: any
) {
  // Handle new plan required
  if (stepStatus === 'new_plan_required') {
    const newPlanContent = extractNewPlanFromText(finalResult);
    if (newPlanContent && effective_plan_id) {
      await createNewPlanForInstance(instance_id, effective_plan_id, newPlanContent, plan);
    }
  }
  
  // Handle new session acquired
  if (stepStatus === 'new_session') {
    const newSessionPattern = /new\s+([a-zA-Z0-9-]+)\s+session\s+acquired/i;
    const match = finalResult.match(newSessionPattern);
    if (match) {
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'session_acquired',
        level: 'info',
        message: `New ${match[1]} session successfully acquired`,
        step_id: `step_${currentStep.order}`,
        details: { 
          platform: match[1], 
          agent_message: finalResult, 
          plan_id: plan.id, 
          plan_title: plan.title 
        },
        instance_id: instance_id,
        site_id: plan.site_id,
        user_id: plan.user_id,
        agent_id: plan.agent_id,
        command_id: plan.command_id,
      });
    }
  }
  
  // Handle user attention required
  if (stepStatus === 'user_attention_required') {
    const userAttentionPattern = /user\s+attention\s+required:\s*(.+)/i;
    const match = finalResult.match(userAttentionPattern);
    if (match) {
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'user_attention_required',
        level: 'warning',
        message: `User attention required: ${match[1]}`,
        step_id: `step_${currentStep.order}`,
        details: {
          attention_reason: match[1],
          agent_message: finalResult,
          plan_id: plan.id,
          plan_title: plan.title,
          requires_user_action: true,
        },
        instance_id: instance_id,
        site_id: plan.site_id,
        user_id: plan.user_id,
        agent_id: plan.agent_id,
        command_id: plan.command_id,
      });
    }
  }
  
  // Handle session needed
  if (stepStatus === 'session_needed') {
    const sessionNeededPattern = /session\s+needed\s+([a-zA-Z0-9-]+)\s+([a-zA-Z0-9.-]+)/i;
    const match = finalResult.match(sessionNeededPattern);
    if (match) {
      await requestSessionCreation(instance_id, match[1], match[2], finalResult, plan);
    }
  }
}
