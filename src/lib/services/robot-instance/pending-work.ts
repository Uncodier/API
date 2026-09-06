import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runAssistantWorkflow } from '@/app/api/robots/instance/assistant/workflow';
import { insertUserActionLog, withRetries } from '@/app/api/robots/instance/assistant/user-message-log';
import { resetRequirementOnUserAction } from '@/lib/services/requirement-cron-reset';

export type PendingWorkStatus = 'pending' | 'claimed' | 'sent' | 'cancelled';

export interface PendingWorkRow {
  id: string;
  instance_id: string;
  site_id: string;
  user_id?: string | null;
  message: string;
  activity?: string | null;
  context?: unknown;
  system_prompt?: string | null;
  status: PendingWorkStatus;
}

export function isRunningUserAction(log: { log_type?: string; details?: { status?: string } | null }): boolean {
  return log.log_type === 'user_action' && log.details?.status === 'running';
}

export function isInstanceIdleFromLogs(logs: Array<{ log_type?: string; details?: { status?: string } | null }>): boolean {
  return !logs.some(isRunningUserAction);
}

export function groupOldestPendingByInstance(rows: PendingWorkRow[]): PendingWorkRow[] {
  const byInstance = new Map<string, PendingWorkRow>();
  for (const row of rows) {
    const current = byInstance.get(row.instance_id);
    if (!current) {
      byInstance.set(row.instance_id, row);
      continue;
    }
    if (current.status !== 'claimed' && row.status === 'claimed') {
      byInstance.set(row.instance_id, row);
    }
  }
  return Array.from(byInstance.values());
}

export async function loadPendingRows(): Promise<PendingWorkRow[]> {
  const { data, error } = await supabaseAdmin
    .from('instance_pending_work')
    .select('id, instance_id, site_id, user_id, message, activity, context, system_prompt, status')
    .in('status', ['pending', 'claimed'])
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    throw new Error(`Failed to load pending work: ${error.message}`);
  }
  return (data || []) as PendingWorkRow[];
}

export async function isInstanceIdle(instanceId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .select('log_type, details')
    .eq('instance_id', instanceId)
    .eq('log_type', 'user_action')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to check instance idle state: ${error.message}`);
  }
  return isInstanceIdleFromLogs(data || []);
}

export async function claimPendingWork(pendingId: string): Promise<PendingWorkRow | null> {
  const claimedAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('instance_pending_work')
    .update({ status: 'claimed', claimed_at: claimedAt })
    .eq('id', pendingId)
    .eq('status', 'pending')
    .select('id, instance_id, site_id, user_id, message, activity, context, system_prompt, status')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to claim pending work: ${error.message}`);
  }
  return (data as PendingWorkRow) || null;
}

export async function markPendingWorkSent(pendingId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('instance_pending_work')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', pendingId);

  if (error) {
    throw new Error(`Failed to mark pending work sent: ${error.message}`);
  }
}

export async function revertPendingWork(pendingId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('instance_pending_work')
    .update({ status: 'pending', claimed_at: null })
    .eq('id', pendingId);

  if (error) {
    throw new Error(`Failed to revert pending work: ${error.message}`);
  }
}

export function stringifyPendingContext(context: unknown): string | undefined {
  if (context == null) return undefined;
  if (typeof context === 'string') return context;
  try {
    return JSON.stringify(context);
  } catch {
    return undefined;
  }
}

export function expectedResultsFromContext(context: unknown): number {
  if (!context || typeof context !== 'object') return 1;
  const record = context as Record<string, unknown>;
  const amount = record.expected_results_amount ?? (record.parameters as Record<string, unknown> | undefined)?.expectedResults;
  const parsed = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.floor(parsed), 20);
}

export async function startPendingAssistant(row: PendingWorkRow): Promise<void> {
  const { data: instance, error } = await supabaseAdmin
    .from('remote_instances')
    .select('site_id, user_id, status')
    .eq('id', row.instance_id)
    .single();

  if (error || !instance) {
    throw new Error('Instance not found');
  }

  const siteId = row.site_id || instance.site_id;
  const userId = row.user_id || instance.user_id;
  const activity = row.activity || 'ask';
  const contextString = stringifyPendingContext(row.context);

  await withRetries(() => insertUserActionLog({
    instanceId: row.instance_id,
    siteId,
    userId,
    message: row.message,
    skipDuplicateCheck: true,
    details: {
      instance_status: instance.status || 'running',
      status: 'running',
      request_type: activity,
      context: row.context || undefined,
      prompt_source: 'pending_work',
    },
  }));

  resetRequirementOnUserAction(row.instance_id).catch(console.error);

  await start(runAssistantWorkflow, [
    row.instance_id,
    row.message,
    siteId,
    userId,
    [],
    false,
    row.system_prompt || undefined,
    undefined,
    undefined,
    undefined,
    expectedResultsFromContext(row.context),
    contextString,
  ]);
}

export async function cancelCurrentAssistantRun(instanceId: string): Promise<{ cancelledLogId: string | null }> {
  const { data: recentLogs, error } = await supabaseAdmin
    .from('instance_logs')
    .select('id, details')
    .eq('instance_id', instanceId)
    .eq('log_type', 'user_action')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to look up running workflow: ${error.message}`);
  }

  const running = (recentLogs || []).find((log) => log.details?.status === 'running');
  if (!running) {
    return { cancelledLogId: null };
  }

  const { error: updateError } = await supabaseAdmin
    .from('instance_logs')
    .update({
      details: {
        ...(running.details || {}),
        status: 'cancelled',
      },
    })
    .eq('id', running.id);

  if (updateError) {
    throw new Error(`Failed to cancel running workflow: ${updateError.message}`);
  }

  const details = (running.details || {}) as Record<string, unknown>;
  const nodeId = typeof details.instance_node_id === 'string' ? details.instance_node_id : null;
  if (nodeId) {
    await supabaseAdmin.from('instance_nodes').update({ status: 'stopped' }).eq('id', nodeId);
  } else {
    await supabaseAdmin
      .from('instance_nodes')
      .update({ status: 'stopped' })
      .eq('instance_id', instanceId)
      .eq('status', 'running');
  }

  const { data: plans } = await supabaseAdmin
    .from('instance_plans')
    .select('id')
    .eq('instance_id', instanceId)
    .in('status', ['in_progress', 'pending']);

  if (plans && plans.length > 0) {
    await supabaseAdmin
      .from('instance_plans')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .in('id', plans.map((plan) => plan.id));
  }

  return { cancelledLogId: running.id };
}

export async function processPendingWorkTick(): Promise<Array<{ instance_id: string; status: string }>> {
  const pending = await loadPendingRows();
  const oldestByInstance = groupOldestPendingByInstance(pending);
  const results: Array<{ instance_id: string; status: string }> = [];

  for (const row of oldestByInstance) {
    try {
      const idle = await isInstanceIdle(row.instance_id);
      if (!idle) {
        results.push({ instance_id: row.instance_id, status: 'busy' });
        continue;
      }

      const claimed = row.status === 'claimed' ? row : await claimPendingWork(row.id);
      if (!claimed) {
        results.push({ instance_id: row.instance_id, status: 'claim_failed' });
        continue;
      }

      try {
        await startPendingAssistant(claimed);
        await markPendingWorkSent(claimed.id);
        results.push({ instance_id: row.instance_id, status: row.status === 'claimed' ? 'retried' : 'sent' });
      } catch (err: any) {
        await revertPendingWork(claimed.id);
        results.push({ instance_id: row.instance_id, status: `reverted: ${err.message}` });
      }
    } catch (err: any) {
      results.push({ instance_id: row.instance_id, status: `error: ${err.message}` });
    }
  }

  return results;
}

export async function sendPendingWorkNow(params: {
  pendingId: string;
  instanceId: string;
}): Promise<{ cancelledLogId: string | null; pendingId: string }> {
  const cancelled = await cancelCurrentAssistantRun(params.instanceId);
  const claimed = await claimPendingWork(params.pendingId);
  if (!claimed) {
    throw new Error('Pending command could not be claimed');
  }
  if (claimed.instance_id !== params.instanceId) {
    await revertPendingWork(claimed.id);
    throw new Error('Pending command does not belong to this instance');
  }

  try {
    await startPendingAssistant(claimed);
    await markPendingWorkSent(claimed.id);
    return { cancelledLogId: cancelled.cancelledLogId, pendingId: claimed.id };
  } catch (err) {
    await revertPendingWork(claimed.id);
    throw err;
  }
}
