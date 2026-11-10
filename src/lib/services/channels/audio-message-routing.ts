import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveAudioRouting, AudioRoutingError } from './audio-routing';

/** Bind the dedicated Twilio adapter to the same saved routing as interventions. */
export async function requireLegacyAudioRouting(siteId: string, conversationId?: string, messageId?: string): Promise<void> {
  if (!conversationId || !messageId) throw new AudioRoutingError('Audio requires a saved message and conversation');
  const { data, error } = await supabaseAdmin.from('messages').select('custom_data')
    .eq('id', messageId).eq('conversation_id', conversationId).maybeSingle();
  if (error || !data) throw new AudioRoutingError('Saved audio routing is unavailable');
  const routing = await resolveAudioRouting({ siteId, conversationId, channel: 'whatsapp',
    connectionId: data.custom_data?.connection_id, allowLegacyWhatsApp: true });
  if (routing.kind !== 'legacy-whatsapp') throw new AudioRoutingError('Saved audio requires its selected Zavu adapter');
}