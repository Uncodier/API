import { supabaseAdmin } from '@/lib/database/supabase-client';

const DUPLICATE_WINDOW_MS = 60_000;

export async function insertUserActionLog(params: {
  instanceId: string;
  siteId: string;
  userId?: string | null;
  message: string;
  details?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from('instance_logs')
    .select('id')
    .eq('instance_id', params.instanceId)
    .eq('log_type', 'user_action')
    .eq('message', params.message)
    .gte('created_at', since)
    .limit(1);

  if (lookupError) {
    throw new Error(`Failed to check existing user message: ${lookupError.message}`);
  }
  if (existing?.[0]?.id) {
    return { id: existing[0].id };
  }

  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .insert({
      log_type: 'user_action',
      level: 'info',
      message: params.message,
      details: {
        prompt_source: 'assistant_route',
        ...(params.details || {}),
      },
      instance_id: params.instanceId,
      site_id: params.siteId,
      user_id: params.userId || null,
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
}): Promise<void> {
  const { error: updateError } = await supabaseAdmin
    .from('remote_instances')
    .update({
      status: 'error',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.instanceId);

  if (updateError) {
    throw new Error(`Failed to mark robot as error: ${updateError.message}`);
  }

  const { error: logError } = await supabaseAdmin.from('instance_logs').insert({
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

  if (logError) {
    throw new Error(`Failed to log robot error: ${logError.message}`);
  }
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
