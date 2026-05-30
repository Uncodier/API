import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Checks if there has been a recent user action (e.g. within 15 minutes) for the given requirement,
 * and if so, resets the `cron_attempts` to 0 to unblock the cron job.
 * 
 * Should be called by tools that modify the requirement (like `requirements` or `requirement_backlog`).
 */
export async function checkAndResetCronAttempts(requirementId: string, metadata: Record<string, unknown> | null): Promise<void> {
  try {
    const instanceId = metadata?.runner_instance_id as string | undefined;
    if (!instanceId) return; // Need an instance ID to find instance_logs

    // Check if the requirement already has cron_attempts = 0 or undefined, then we don't need to do anything
    if (metadata?.cron_attempts === undefined || metadata?.cron_attempts === 0) {
      return;
    }

    // Check for recent user action (last 15 minutes)
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    
    const { data: recentLogs, error: logError } = await supabaseAdmin
      .from('instance_logs')
      .select('id')
      .eq('instance_id', instanceId)
      .eq('log_type', 'user_action')
      .gt('created_at', fifteenMinutesAgo)
      .limit(1);

    if (logError) {
      console.warn(`[CronReset] Error querying instance_logs for requirement ${requirementId}:`, logError);
      return;
    }

    if (recentLogs && recentLogs.length > 0) {
      console.log(`[CronReset] Recent user action detected for requirement ${requirementId}. Resetting cron_attempts to 0.`);
      
      const updatedMetadata = {
        ...metadata,
        cron_attempts: 0
      };
      
      const { error: updateError } = await supabaseAdmin
        .from('requirements')
        .update({ metadata: updatedMetadata, status: 'in-progress' })
        .eq('id', requirementId);
        
      if (updateError) {
        console.warn(`[CronReset] Failed to reset cron_attempts for requirement ${requirementId}:`, updateError);
      }
    }
  } catch (error) {
    console.error(`[CronReset] Unexpected error:`, error);
  }
}

/**
 * Resets the cron_attempts to 0 and sets status to in-progress for the requirement associated 
 * with the given instance_id. To be called immediately when a user sends a message.
 */
export async function resetRequirementOnUserAction(instanceId: string): Promise<void> {
  try {
    // Find requirement ID by checking requirement_status
    let requirementId: string | undefined;
    
    const { data: reqStatus, error: statusErr } = await supabaseAdmin
      .from('requirement_status')
      .select('requirement_id')
      .eq('instance_id', instanceId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
      
    if (reqStatus?.requirement_id) {
      requirementId = reqStatus.requirement_id;
    } else {
      // Fallback: check metadata
      const { data: reqs } = await supabaseAdmin
        .from('requirements')
        .select('id')
        .contains('metadata', { runner_instance_id: instanceId })
        .limit(1)
        .single();
        
      if (reqs?.id) {
        requirementId = reqs.id;
      }
    }
    
    if (requirementId) {
      const { data: req } = await supabaseAdmin
        .from('requirements')
        .select('metadata, status')
        .eq('id', requirementId)
        .single();
        
      if (req) {
        // If it's already in progress and has 0 attempts, no need to update
        if (req.status === 'in-progress' && (req.metadata?.cron_attempts === 0 || req.metadata?.cron_attempts === undefined)) {
          return;
        }
        
        const updatedMetadata = { ...(req.metadata || {}), cron_attempts: 0 };
        await supabaseAdmin
          .from('requirements')
          .update({ metadata: updatedMetadata, status: 'in-progress', updated_at: new Date().toISOString() })
          .eq('id', requirementId);
          
        console.log(`[CronReset] User action on instance ${instanceId} -> Reset requirement ${requirementId} to in-progress (cron_attempts=0)`);
      }
    }
  } catch (error) {
    console.error(`[CronReset] Error resetting requirement for instance ${instanceId}:`, error);
  }
}
