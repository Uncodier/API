import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Read raw columns only: legacy command converters can recover missing agent IDs from prompt text. */
export async function isAssignedChannelCommand(id: string, siteId: string, agentId: string, userId?: string): Promise<boolean> {
  let query = supabaseAdmin.from('commands').select('id,site_id,agent_id,user_id')
    .eq('id', id).eq('site_id', siteId).eq('agent_id', agentId);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query.abortSignal(AbortSignal.timeout(5000)).maybeSingle();
  return !error && data?.id === id && data.site_id === siteId && data.agent_id === agentId && (!userId || data.user_id === userId);
}
