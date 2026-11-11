import { supabaseAdmin } from '@/lib/database/supabase-client';

/** remote_sessions has a unique phone_number key, not an email column.
 * Namespace email identities so they cannot collide with WhatsApp numbers.
 * The identity must come from the authenticated channel, never model arguments.
 */
export function agentProjectSessionKey(identity: string): string {
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('Agent project session identity is required');
  return trimmed.includes('@') ? `email:${trimmed.toLowerCase()}` : trimmed;
}

export async function saveAgentProjectSession(
  identity: string, userId: string, siteId: string, instanceId: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin.from('remote_sessions').upsert({
    phone_number: agentProjectSessionKey(identity),
    user_id: userId,
    site_id: siteId,
    instance_id: instanceId,
  }, { onConflict: 'phone_number' });
  if (error) throw new Error('Failed to update active project in database');
}