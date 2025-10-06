/**
 * Error Handler Service
 * Handles error logging and response building for plan execution failures
 */

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Handle plan execution error
 */
export async function handlePlanExecutionError(
  err: any,
  currentStep: any,
  effective_plan_id: string | undefined,
  instance_id: string | undefined,
  plan: any
): Promise<NextResponse> {
  console.error('Error in POST /robots/plan/act:', err);
  
  if (currentStep && currentStep.id && effective_plan_id) {
    try {
      await supabaseAdmin
        .from('instance_plans')
        .update({ 
          status: 'failed', 
          error_message: `Error: ${err.message}`,
          updated_at: new Date().toISOString()
        })
        .eq('id', effective_plan_id);

      if (instance_id) {
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'error',
          level: 'error',
          message: `Error executing plan step: ${err.message}`,
          step_id: currentStep ? `step_${currentStep.order}` : null,
          details: { 
            error: err.message, 
            stack: err.stack,
            plan_id: effective_plan_id,
            plan_title: plan?.title,
          },
          instance_id: instance_id,
          site_id: plan?.site_id,
          user_id: plan?.user_id,
          agent_id: plan?.agent_id,
          command_id: plan?.command_id,
        });
      }
    } catch (logError) {
      console.error('Error saving error log:', logError);
    }
  }

  return NextResponse.json({ 
    data: {
      error: err.message,
      message: 'Plan execution failed',
      step: currentStep ? {
        id: currentStep.id,
        order: currentStep.order,
        title: currentStep.title,
        status: 'failed',
        result: `Error: ${err.message}`,
        actual_output: `Error: ${err.message}`,
        error_message: err.message,
        completed_at: null,
        started_at: new Date().toISOString(),
      } : null,
      plan_completed: false,
      plan_failed: true,
    }
  }, { status: 500 });
}
