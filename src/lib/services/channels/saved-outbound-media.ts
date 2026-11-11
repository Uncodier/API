import { supabaseAdmin } from '@/lib/database/supabase-client';
import { OutboundMediaError, validateOutboundMedia, type OutboundMedia } from './outbound-media';

/** Prevent approval/retry callers from replacing the persisted file or caption. */
export async function requireSavedOutboundMedia(input: {
  site_id: string; conversation_id?: string; message_id?: string; message?: string; media_urls?: string[];
}, channel: string, media: OutboundMedia | undefined) {
  const legacyUrls = input.media_urls || [];
  if ((!media && !legacyUrls.length) || !input.message_id) return undefined;
  const { data: saved, error } = await supabaseAdmin.from('messages')
    .select('role, content, conversation_id, custom_data, conversations!inner(site_id, channel, custom_data)')
    .eq('id', input.message_id).eq('conversations.site_id', input.site_id).maybeSingle();
  if (error || !saved || !['assistant', 'team_member'].includes(saved.role)
    || (input.conversation_id && saved.conversation_id !== input.conversation_id)
    || saved.content !== (input.message || '') || saved.custom_data?.status === 'pending') {
    throw new OutboundMediaError('Saved media message is unavailable, unapproved or does not match the request');
  }
  const conversation = Array.isArray(saved.conversations) ? saved.conversations[0] : saved.conversations;
  const source = saved.custom_data?.source;
  const sourceChannel = ['whatsapp', 'telegram', 'messenger', 'instagram', 'email', 'sms', 'voice'].includes(source) ? source : undefined;
  const storedChannel = saved.custom_data?.channel || sourceChannel
    || conversation?.channel || conversation?.custom_data?.channel;
  if (typeof storedChannel === 'string' && storedChannel.toLowerCase() !== channel.toLowerCase()) {
    throw new OutboundMediaError('Media delivery channel must match the saved conversation');
  }
  const stored = await validateOutboundMedia(saved.custom_data || {}, channel);
  const matches = media ? stored && JSON.stringify(stored) === JSON.stringify(media)
    : stored && legacyUrls.length === 1 && legacyUrls[0] === stored.content.mediaUrl;
  if (!matches) {
    throw new OutboundMediaError('Media must match the saved message attachment');
  }
  return saved.custom_data as Record<string, unknown>;
}