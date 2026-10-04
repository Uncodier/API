import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Site authorization is checked separately; optional asset links must belong to that site. */
export async function mediaInstanceBelongsToSite(siteId: string, instanceId: unknown): Promise<boolean> {
  if (instanceId === undefined) return true;
  if (typeof instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) return false;
  const { data, error } = await supabaseAdmin.from('remote_instances')
    .select('id').eq('id', instanceId).eq('site_id', siteId).maybeSingle();
  return !error && Boolean(data);
}