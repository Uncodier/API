'use step';

import { insertUserActionLog, markRemoteInstanceError } from './user-message-log';

export async function persistUserMessageStep(
  instanceId: string,
  message: string,
  siteId: string,
  userId?: string | null,
  details?: Record<string, unknown>
): Promise<{ id: string }> {
  'use step';
  return insertUserActionLog({
    instanceId,
    siteId,
    userId,
    message,
    details,
  });
}

export async function markAssistantFailedStep(
  instanceId: string,
  siteId: string,
  userId: string | null | undefined,
  errorMessage: string
): Promise<void> {
  'use step';
  await markRemoteInstanceError({
    instanceId,
    siteId,
    userId,
    errorMessage,
  });
}

export async function completeUserMessageStep(logId: string): Promise<void> {
  'use step';
  const { supabaseAdmin } = await import('@/lib/database/supabase-client');
  const { data: log } = await supabaseAdmin.from('instance_logs').select('details').eq('id', logId).single();
  if (log) {
    await supabaseAdmin.from('instance_logs').update({
      details: { ...(log.details || {}), status: 'completed' }
    }).eq('id', logId);
  }
}
