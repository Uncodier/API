import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resumeRequirementExecutionOnUserAction } from './requirement-execution-recovery';

async function findLatestUserActionId(
  instanceId: string,
  requirementId: string,
  createdAfter?: string,
): Promise<string | null> {
  let query = supabaseAdmin
    .from('instance_logs')
    .select('id')
    .eq('instance_id', instanceId)
    .eq('log_type', 'user_action')
    .eq('trusted_user_action', true)
    .filter('details->>requirement_id', 'eq', requirementId);
  if (createdAfter) {
    query = query.gt('created_at', createdAfter);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(
      `Failed to load the latest user action: ${error.message}`,
    );
  }
  return typeof data?.[0]?.id === 'string' ? data[0].id : null;
}

async function tagUserActionWithRequirement(
  actionId: string,
  instanceId: string,
  requirementId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .select('details, instance_id, log_type, trusted_user_action')
    .eq('id', actionId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load user action ${actionId}: ${error.message}`);
  }
  if (
    !data ||
    data.instance_id !== instanceId ||
    data.log_type !== 'user_action' ||
    data.trusted_user_action !== true
  ) {
    return false;
  }
  const details =
    data.details && typeof data.details === 'object' ? data.details : {};
  const existingRequirementId =
    (details as Record<string, unknown>).requirement_id;
  if (
    typeof existingRequirementId === 'string' &&
    existingRequirementId !== requirementId
  ) {
    return false;
  }
  const { error: updateError } = await supabaseAdmin
    .from('instance_logs')
    .update({
      details: {
        ...details,
        requirement_id: requirementId,
      },
    })
    .eq('id', actionId);
  if (updateError) {
    throw new Error(`Failed to scope user action ${actionId}: ${updateError.message}`);
  }
  return true;
}

/**
 * Checks if there has been a recent user action (e.g. within 15 minutes) for the given requirement,
 * and if so, resets the `cron_attempts` to 0 to unblock the cron job.
 * 
 * Should be called by tools that modify the requirement (like `requirements` or `requirement_backlog`).
 */
export async function checkAndResetCronAttempts(
  requirementId: string,
  metadata: Record<string, unknown> | null,
): Promise<boolean> {
  try {
    const instanceId = metadata?.runner_instance_id as string | undefined;
    if (!instanceId) return false; // Need an instance ID to find instance_logs

    // Check for recent user action (last 15 minutes)
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    
    const actionId = await findLatestUserActionId(
      instanceId,
      requirementId,
      fifteenMinutesAgo,
    );
    if (actionId) {
      const recovery = await resumeRequirementExecutionOnUserAction(
        requirementId,
        instanceId,
        true,
        actionId,
      );
      console.log(
        `[CronReset] Recent user action detected for requirement ${requirementId}. ` +
        `Resetting cron attempts and reopening ` +
        `${recovery.reopened_item_ids.length} review item(s).`,
      );
      return recovery.state === 'applied';
    }
  } catch (error) {
    console.error(`[CronReset] Unexpected error:`, error);
  }
  return false;
}

/**
 * Resets the cron_attempts to 0 and sets status to in-progress for the requirement associated 
 * with the given instance_id. To be called immediately when a user sends a message.
 */
export async function resetRequirementOnUserAction(
  instanceId: string,
  insertedActionId?: string,
): Promise<void> {
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
      const actionId =
        insertedActionId ||
        await findLatestUserActionId(instanceId, requirementId);
      if (!actionId) {
        console.warn(
          `[CronReset] No user-action identity found for instance ${instanceId}; recovery was not applied.`,
        );
        return;
      }
      try {
        const scoped = await tagUserActionWithRequirement(
          actionId,
          instanceId,
          requirementId,
        );
        if (!scoped) {
          console.warn(
            `[CronReset] User action ${actionId} belongs to another requirement; recovery was skipped.`,
          );
          return;
        }
      } catch (error) {
        console.warn(
          `[CronReset] Failed to scope user action ${actionId} to requirement ${requirementId}:`,
          error,
        );
        return;
      }
      const recovery = await resumeRequirementExecutionOnUserAction(
        requirementId,
        instanceId,
        true,
        actionId,
      );
      if (recovery.state === 'missing' || recovery.state === 'untrusted') {
        return;
      }

      console.log(
        `[CronReset] User action on instance ${instanceId} -> Reset requirement ${requirementId} to in-progress (cron_attempts=0, reopened=${recovery.reopened_item_ids.length})`,
      );
    }
  } catch (error) {
    console.error(`[CronReset] Error resetting requirement for instance ${instanceId}:`, error);
  }
}
