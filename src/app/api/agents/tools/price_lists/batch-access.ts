import { supabaseAdmin as db } from '@/lib/database/supabase-client';

/** Host-authenticated actor only. Do not call with identity taken from tool arguments. */
export async function requireCommerceBatchManager(siteId: string, userId: string): Promise<boolean> {
  const access = await db.rpc('site_user_has_effective_access', { p_site_id: siteId, p_user_id: userId });
  const site = await db.from('sites').select('user_id').eq('id', siteId).maybeSingle();
  if (access.error || access.data !== true || site.error || !site.data) return false;
  const members = await db.from('site_members').select('id, role', { count: 'exact' })
    .eq('site_id', siteId).eq('user_id', userId).eq('status', 'active');
  if (members.error || members.count == null || members.count > 1) return false;
  const manager = members.count === 1 && members.data?.length === 1
    && ['owner', 'admin'].includes(members.data[0].role);
  return site.data.user_id === userId || Boolean(manager);
}