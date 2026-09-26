import { supabaseAdmin } from '@/lib/database/supabase-client';

const DUPLICATE_WINDOW_MS = 60_000;

export async function insertUserActionLog(params: {
  instanceId: string;
  siteId: string;
  userId?: string | null;
  message: string;
  details?: Record<string, unknown>;
  skipDuplicateCheck?: boolean;
  agentId?: string | null;
  commandId?: string | null;
}): Promise<{ id: string }> {
  if (!params.skipDuplicateCheck) {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('instance_logs')
      .select('id')
      .eq('instance_id', params.instanceId)
      .eq('site_id', params.siteId)
      .eq('log_type', 'user_action')
      .eq('trusted_user_action', true)
      .eq('message', params.message)
      .gte('created_at', since)
      .limit(1);

    if (lookupError) {
      throw new Error(`Failed to check existing user message: ${lookupError.message}`);
    }
    if (existing?.[0]?.id) {
      return { id: existing[0].id };
    }
  }

  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .insert({
      log_type: 'user_action',
      level: 'info',
      message: params.message,
      details: {
        ...(params.details || {}),
        prompt_source: 'assistant_route',
      },
      trusted_user_action: true,
      instance_id: params.instanceId,
      site_id: params.siteId,
      user_id: params.userId || null,
      ...(params.agentId ? { agent_id: params.agentId } : {}),
      ...(params.commandId ? { command_id: params.commandId } : {}),
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    throw new Error(`Failed to persist user message: ${error?.message || 'no row returned'}`);
  }

  return { id: data.id };
}

export async function markRemoteInstanceError(params: {
  instanceId: string;
  siteId: string;
  userId?: string | null;
  errorMessage: string;
  userMessageLogId?: string | null;
}): Promise<void> {
  const update = async () => supabaseAdmin
    .from('remote_instances')
    .update({
      status: 'error',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.instanceId).eq('site_id', params.siteId);

  const insert = async () => supabaseAdmin.from('instance_logs').insert({
    log_type: 'error',
    level: 'error',
    message: `Assistant failed after retries: ${params.errorMessage}`.slice(0, 2000),
    details: {
      error: params.errorMessage,
      source: 'assistant_retry_exhausted',
    },
    instance_id: params.instanceId,
    site_id: params.siteId,
    user_id: params.userId || null,
  });
  // A denied status update must not suppress the error log, or vice versa.
  const [updated, logged, userLog] = await Promise.allSettled([
    update(), insert(), params.userMessageLogId
      ? setUserMessageStatus(params.userMessageLogId, 'failed') : Promise.resolve(),
  ]);
  const updateError = updated.status === 'rejected' ? updated.reason : updated.value.error;
  const logError = logged.status === 'rejected' ? logged.reason : logged.value.error;
  if (logError) {
    throw new Error(`Failed to log robot error: ${logError.message}`);
  }
  if (updateError) {
    throw new Error(`Failed to mark robot as error: ${updateError.message}`);
  }
  if (userLog.status === 'rejected') throw userLog.reason;
}

export async function setUserMessageStatus(logId: string, status: 'completed' | 'failed' | 'paused'): Promise<void> {
  const { data, error } = await supabaseAdmin.from('instance_logs').select('details')
    .eq('id', logId).eq('log_type', 'user_action').single();
  if (error || !data) throw new Error('Failed to read the user message status');
  // An explicit cancellation must not be undone by a late workflow checkpoint.
  if (data.details?.status === 'cancelled' || data.details?.status === 'stopped') return;
  const { error: updateError } = await supabaseAdmin.from('instance_logs').update({
    details: { ...(data.details || {}), status },
  }).eq('id', logId).eq('log_type', 'user_action');
  if (updateError) throw new Error('Failed to save the user message status');
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 300
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (i - 1)));
      }
    }
  }
  throw lastError;
}
