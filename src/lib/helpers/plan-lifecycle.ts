/**
 * Plan Lifecycle Management
 * Centralized utilities for managing the lifecycle of instance plans
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { closeSupersededPlan } from './plan-status';

export interface CompletePlanResult {
  success: boolean;
  completedCount: number;
  errors: string[];
}

/**
 * Close all active plans (in_progress, active, pending, paused) for an instance.
 * Fully finished plans become completed; superseded plans with unfinished
 * steps become cancelled so the parent status never contradicts its steps.
 * This ensures only one active plan exists at a time
 * 
 * @param instanceId - The instance ID to complete plans for
 * @param completionReason - Optional reason for completing the plans
 * @param options - Excludes the newly-created replacement and, when supplied,
 * only closes plans older than that replacement.
 * @returns Result object with success status, count, and any errors
 */
export async function completeInProgressPlans(
  instanceId: string,
  completionReason: string = 'Superseded by a new plan',
  options?: {
    excludePlanId?: string;
    createdBefore?: string;
  },
): Promise<CompletePlanResult> {
  const result: CompletePlanResult = {
    success: false,
    completedCount: 0,
    errors: []
  };

  try {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Checking for active plans to complete for instance: ${instanceId}`);
    
    // Find all active plans for this instance
    let activePlansQuery = supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instanceId)
      .in('status', ['in_progress', 'active', 'pending', 'paused']);
    if (options?.excludePlanId) {
      activePlansQuery = activePlansQuery.neq('id', options.excludePlanId);
    }
    if (options?.createdBefore) {
      activePlansQuery = activePlansQuery.lt('created_at', options.createdBefore);
    }
    const { data: activePlans, error: fetchError } = await activePlansQuery;

    if (fetchError) {
      const errorMsg = `Error fetching active plans: ${fetchError.message}`;
      console.error(errorMsg, fetchError);
      result.errors.push(errorMsg);
      return result;
    }

    if (!activePlans || activePlans.length === 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No active plans found to complete`);
      result.success = true;
      return result;
    }

    const closablePlans = activePlans.filter((plan) => {
      const meta = (plan.metadata || {}) as { workflow_template?: boolean; workflow_run?: boolean };
      return !meta.workflow_template && !meta.workflow_run;
    });

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found ${closablePlans.length} active plan(s) to complete`);

    // Close all active plans without manufacturing false completion.
    for (const plan of closablePlans) {
      const nowIso = new Date().toISOString();
      const closure = closeSupersededPlan(
        Array.isArray(plan.steps) ? plan.steps : [],
        completionReason,
        nowIso,
      );
      const { error: updateError } = await supabaseAdmin
        .from('instance_plans')
        .update({
          status: closure.status,
          steps: closure.steps,
          steps_completed: closure.completedCount,
          progress_percentage: closure.progressPercentage,
          completed_at: nowIso,
          updated_at: nowIso,
          completion_reason: completionReason,
        })
        .eq('id', plan.id);

      if (updateError) {
        const errorMsg = `Failed to complete plan ${plan.id}: ${updateError.message}`;
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ ${errorMsg}`);
        result.errors.push(errorMsg);
      } else {
        result.completedCount++;
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Plan ${plan.id} marked as ${closure.status} (was ${plan.status})`);
      }
    }

    result.success =
      result.errors.length === 0 &&
      result.completedCount === closablePlans.length;
    
    if (result.errors.length > 0) {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Closed ${result.completedCount}/${closablePlans.length} plans with ${result.errors.length} error(s)`);
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Successfully closed all ${result.completedCount} active plan(s)`);
    }

    return result;
  } catch (error: any) {
    const errorMsg = `Unexpected error completing plans: ${error.message}`;
    console.error(errorMsg, error);
    result.errors.push(errorMsg);
    return result;
  }
}

/**
 * Replace an existing plan with a new one
 * Marks the old plan as 'replaced' instead of 'completed'
 * 
 * @param planId - The plan ID to replace
 * @param replacementReason - Reason for replacement
 */
export async function replacePlan(
  planId: string,
  replacementReason: string = 'Plan replaced by new plan'
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'replaced',
        replaced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        replacement_reason: replacementReason
      })
      .eq('id', planId);

    if (error) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Failed to replace plan ${planId}:`, error);
      return { success: false, error: error.message };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Plan ${planId} marked as replaced`);
    return { success: true };
  } catch (error: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Unexpected error replacing plan:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Pause a plan
 * 
 * @param planId - The plan ID to pause
 */
export async function pausePlan(
  planId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'paused',
        paused_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', planId);

    if (error) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Failed to pause plan ${planId}:`, error);
      return { success: false, error: error.message };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⏸️ Plan ${planId} paused`);
    return { success: true };
  } catch (error: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Unexpected error pausing plan:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Resume a paused plan
 * 
 * @param planId - The plan ID to resume
 */
export async function resumePlan(
  planId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'in_progress',
        resumed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', planId);

    if (error) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Failed to resume plan ${planId}:`, error);
      return { success: false, error: error.message };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ▶️ Plan ${planId} resumed`);
    return { success: true };
  } catch (error: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Unexpected error resuming plan:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Mark all running plans as failed for an instance
 * This is used when an instance is stopped or paused
 * 
 * @param instanceId - The instance ID to mark plans as failed for
 * @param failureReason - Reason for marking plans as failed
 * @returns Result object with success status, count, and any errors
 */
export async function markRunningPlansAsFailed(
  instanceId: string,
  failureReason: string = 'Instance was stopped while plan was running'
): Promise<CompletePlanResult> {
  const result: CompletePlanResult = {
    success: false,
    completedCount: 0,
    errors: []
  };

  try {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Marking running plans as failed for instance: ${instanceId}`);
    
    // Find all running plans for this instance
    const { data: runningPlans, error: fetchError } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instanceId)
      .in('status', ['in_progress', 'paused']);

    if (fetchError) {
      const errorMsg = `Error fetching running plans: ${fetchError.message}`;
      console.error(errorMsg, fetchError);
      result.errors.push(errorMsg);
      return result;
    }

    if (!runningPlans || runningPlans.length === 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No running plans found to mark as failed`);
      result.success = true;
      return result;
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found ${runningPlans.length} running plan(s) to mark as failed`);

    // Mark all running plans as failed
    for (const plan of runningPlans) {
      const { error: updateError } = await supabaseAdmin
        .from('instance_plans')
        .update({
          status: 'failed',
          error_message: failureReason,
          updated_at: new Date().toISOString()
        })
        .eq('id', plan.id);

      if (updateError) {
        const errorMsg = `Failed to mark plan ${plan.id} as failed: ${updateError.message}`;
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ ${errorMsg}`);
        result.errors.push(errorMsg);
      } else {
        result.completedCount++;
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Plan ${plan.id} marked as failed (was ${plan.status})`);
      }
    }

    // Consider it a success if we marked at least some plans as failed
    result.success = result.completedCount > 0 || runningPlans.length === 0;
    
    if (result.errors.length > 0) {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Marked ${result.completedCount}/${runningPlans.length} plans as failed with ${result.errors.length} error(s)`);
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Successfully marked all ${result.completedCount} running plan(s) as failed`);
    }

    return result;
  } catch (error: any) {
    const errorMsg = `Unexpected error marking plans as failed: ${error.message}`;
    console.error(errorMsg, error);
    result.errors.push(errorMsg);
    return result;
  }
}

export function planCancelledBySaneo(plan: {
  status?: string | null;
  metadata?: unknown;
  completion_reason?: string | null;
} | null | undefined): boolean {
  if (!plan || !/^(cancelled|failed)$/.test(String(plan.status || ''))) return false;
  const blob = `${JSON.stringify(plan.metadata || {})} ${plan.completion_reason || ''}`.toLowerCase();
  return blob.includes('auto-saneo');
}

export {
  applyItemExhaustionToSteps,
  cancelPlanStepsForBacklogItem,
} from './plan-lifecycle-cancellation';
export type {
  CancelPlanStepsForItemResult,
} from './plan-lifecycle-cancellation';

/**
 * Get all active plans for an instance
 * 
 * @param instanceId - The instance ID to get plans for
 * @returns Array of active plans
 */
export async function getActivePlans(instanceId: string) {
  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .select('*')
    .eq('instance_id', instanceId)
    .in('status', ['in_progress', 'active', 'pending', 'paused'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error fetching active plans:`, error);
    return [];
  }

  return data || [];
}

