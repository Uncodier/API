import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Server-side role check for all skill writes, including tool calls. Fail closed on lookup errors. */
export async function isSiteSkillManager(siteId: string, userId: string): Promise<boolean> {
  const { data: owner, error: siteError } = await supabaseAdmin.from('sites')
    .select('id').eq('id', siteId).eq('user_id', userId).maybeSingle();
  if (siteError) throw new Error('Unable to verify site role');
  if (owner) return true;

  const { data: ownership, error: ownershipError } = await supabaseAdmin.from('site_ownership')
    .select('site_id').eq('site_id', siteId).eq('user_id', userId).maybeSingle();
  if (ownershipError) throw new Error('Unable to verify site role');
  if (ownership) return true;

  const { data: membership, error: membershipError } = await supabaseAdmin.from('site_members')
    .select('role').eq('site_id', siteId).eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (membershipError) throw new Error('Unable to verify site role');
  return Boolean(membership && ['owner', 'admin'].includes(membership.role));
}