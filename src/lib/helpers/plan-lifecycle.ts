/**
 * Plan Lifecycle Management
 * Centralized utilities for managing the lifecycle of instance plans
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface CompletePlanResult {
  success: boolean;
  completedCount: number;
  errors: string[];
}

/**
 * Complete all active plans (in_progress, active, pending, paused) for an instance
 * This ensures only one active plan exists at a time
 * 
 * @param instanceId - The instance ID to complete plans for
 * @param completionReason - Optional reason for completing the plans
 * @returns Result object with success status, count, and any errors
 */
export async function completeInProgressPlans(
  instanceId: string,
  completionReason: string = 'New plan created - previous plan auto-completed'
): Promise<CompletePlanResult> {
  const result: CompletePlanResult = {
    success: false,
    completedCount: 0,
    errors: []
  };

  try {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Checking for active plans to complete for instance: ${instanceId}`);
    
    // Find all active plans for this instance
    const { data: activePlans, error: fetchError } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instanceId)
      .in('status', ['in_progress', 'active', 'pending', 'paused']);

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

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found ${activePlans.length} active plan(s) to complete`);

    // Complete all active plans
    for (const plan of activePlans) {
      const { error: updateError } = await supabaseAdmin
        .from('instance_plans')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completion_reason: completionReason
        })
        .eq('id', plan.id);

      if (updateError) {
        const errorMsg = `Failed to complete plan ${plan.id}: ${updateError.message}`;
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ ${errorMsg}`);
        result.errors.push(errorMsg);
      } else {
        result.completedCount++;
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Plan ${plan.id} marked as completed (was ${plan.status})`);
      }
    }

    // Consider it a success if we completed at least some plans
    result.success = result.completedCount > 0 || activePlans.length === 0;
    
    if (result.errors.length > 0) {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Completed ${result.completedCount}/${activePlans.length} plans with ${result.errors.length} error(s)`);
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Successfully completed all ${result.completedCount} active plan(s)`);
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

