/**
 * Response Builder Service
 * Builds final API responses with all necessary data
 */

/**
 * Build success response
 */
export function buildSuccessResponse(
  stepStatus: string,
  currentStep: any,
  finalResult: string,
  executionStartTime: number,
  planUpdateData: any,
  existingSessions: any[],
  executionResult: any,
  remoteInstance: any,
  user_instruction?: string
) {
  const { steps, usage } = executionResult;
  
  const isPlanCompleted = (planUpdateData.status === 'completed');
  const isPlanFailed = stepStatus === 'plan_failed' || stepStatus === 'failed';
  const isNewPlanRequired = stepStatus === 'new_plan_required';
  const isNewSession = stepStatus === 'new_session';
  const isUserAttentionRequired = stepStatus === 'user_attention_required';
  const isSessionNeeded = stepStatus === 'session_needed';
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Final plan status evaluation: isPlanCompleted=${isPlanCompleted} (${planUpdateData.steps_completed}/${planUpdateData.steps_total}), stepStatus=${stepStatus}`);

  // Extract session/failure info if needed
  let sessionRequest = null;
  let newSessionInfo = null;
  let failureReason = null;
  let userAttentionInfo = null;
  
  if (isSessionNeeded) {
    const sessionNeededPattern = /session\s+needed\s+([a-zA-Z0-9-]+)\s+([a-zA-Z0-9.-]+)/i;
    const match = finalResult.match(sessionNeededPattern);
    if (match) {
      sessionRequest = {
        platform: match[1],
        domain: match[2],
        suggested_auth_type: match[1] === 'google' || match[1] === 'youtube' ? 'oauth' : 'cookies'
      };
    }
  }
  
  if (isNewSession) {
    const newSessionPattern = /new\s+([a-zA-Z0-9-]+)\s+session\s+acquired/i;
    const match = finalResult.match(newSessionPattern);
    if (match) {
      newSessionInfo = {
        platform: match[1],
        status: 'acquired',
        message: finalResult
      };
    }
  }
  
  if (isPlanFailed && stepStatus === 'plan_failed') {
    const planFailedPattern = /plan\s+failed:\s*(.+)/i;
    const match = finalResult.match(planFailedPattern);
    if (match) {
      failureReason = match[1].trim();
    }
  }
  
  if (isUserAttentionRequired) {
    const userAttentionPattern = /user\s+attention\s+required:\s*(.+)/i;
    const match = finalResult.match(userAttentionPattern);
    if (match) {
      userAttentionInfo = {
        reason: match[1].trim(),
        message: finalResult,
        requires_user_action: true
      };
    }
  }

  return {
    data: {
      message: `Plan executed with status: ${stepStatus}`,
      step: {
        id: currentStep.id,
        order: currentStep.order,
        title: currentStep.title,
        status: stepStatus === 'completed' ? 'completed' : 
                stepStatus === 'failed' || stepStatus === 'plan_failed' ? 'failed' : 
                stepStatus === 'canceled' ? 'cancelled' : 'in_progress',
        result: finalResult,
        actual_output: finalResult,
        duration_seconds: Math.round((Date.now() - executionStartTime) / 1000),
        completed_at: stepStatus === 'completed' ? new Date().toISOString() : null,
        started_at: new Date().toISOString(),
      },
      plan_completed: isPlanCompleted,
      plan_failed: isPlanFailed,
      failure_reason: failureReason,
      new_plan_required: isNewPlanRequired,
      new_session: isNewSession,
      user_attention_required: isUserAttentionRequired,
      user_attention_info: userAttentionInfo,
      session_needed: isSessionNeeded,
      session_request: sessionRequest,
      new_session_info: newSessionInfo,
      available_sessions: existingSessions?.map(session => ({
        name: session.name,
        domain: session.domain,
        auth_type: session.auth_type,
        last_used: session.last_used_at
      })) || [],
      plan_progress: {
        completed_steps: planUpdateData.steps_completed,
        total_steps: planUpdateData.steps_total,
        percentage: planUpdateData.progress_percentage,
      },
      requires_continuation: stepStatus === 'in_progress' || stepStatus === 'new_session',
      is_blocked: stepStatus === 'blocked' || stepStatus === 'failed' || stepStatus === 'plan_failed' || stepStatus === 'user_attention_required',
      waiting_for_session: isSessionNeeded,
      waiting_for_user: isUserAttentionRequired,
      user_instruction_added: !!user_instruction,
      execution_time_ms: Date.now() - executionStartTime,
      timeout: false,
      steps_executed: steps?.length || 0,
      token_usage: usage,
      remote_instance_id: remoteInstance.id,
    }
  };
}
