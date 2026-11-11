import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { OutboundMediaError } from './outbound-media';

/** Sticky claim on the original record: even recovery of `sending` cannot resend it. */
export async function dispatchNativeMedia<T>(input: {
  site_id: string; message_id?: string; conversation_id?: string; message?: string;
  media_url?: unknown; message_type?: unknown; mime_type?: unknown; media_urls?: string[];
}, provider: string, send: () => Promise<T>, receipt: (result: T) => {
  id?: string; status?: 'sent' | 'pending'; skipped?: boolean;
}): Promise<T> {
  if (!input.message_id) return send();
  const { data: saved, error } = await supabaseAdmin.from('messages')
    .select('id, role, content, conversation_id, custom_data, conversations!inner(site_id)')
    .eq('id', input.message_id).eq('conversations.site_id', input.site_id).maybeSingle();
  if (error || !saved || !['assistant', 'team_member'].includes(saved.role)
    || (input.message !== undefined && saved.content !== input.message)
    || (input.conversation_id && saved.conversation_id !== input.conversation_id)) {
    throw new OutboundMediaError('Saved media delivery scope is unavailable');
  }
  const previous = saved.custom_data || {};
  if ((input.media_url !== undefined && (input.media_url !== previous.media_url
    || input.message_type !== previous.message_type || input.mime_type !== previous.mime_type))
    || (input.media_urls?.length && (input.media_urls.length !== 1 || input.media_urls[0] !== previous.media_url))) {
    throw new OutboundMediaError('Saved attachment changed before media dispatch');
  }
  if (previous.automation_skipped === true || previous.status === 'skipped') {
    throw new OutboundMediaError('Media delivery was suppressed and cannot be retried');
  }
  if (previous.native_media_delivery || previous.provider_message_id
    || ['pending', 'sent', 'delivered', 'read', 'reconciliation_required'].includes(previous.status)) {
    throw new OutboundMediaError('Media delivery is unapproved or requires receipt reconciliation before another attempt');
  }
  const attempt = { id: randomUUID(), provider, state: 'attempting', at: new Date().toISOString() };
  let claim = supabaseAdmin.from('messages').update({ custom_data: {
    ...previous, status: 'reconciliation_required', native_media_delivery: attempt,
  } }).eq('id', saved.id).eq('conversation_id', saved.conversation_id);
  claim = saved.custom_data == null ? claim.is('custom_data', null) : claim.eq('custom_data', JSON.stringify(previous));
  const claimed = await claim.select('id').maybeSingle();
  if (claimed.error || !claimed.data) throw new OutboundMediaError('Media delivery was already claimed or changed');
  // Any error after this point remains sticky, including provider timeouts and receipt write failures.
  const result = await send();
  const accepted = receipt(result);
  if (!accepted.skipped && (!accepted.id || accepted.id === 'unknown')) {
    throw new OutboundMediaError('Media provider did not confirm acceptance; reconciliation required');
  }
  const current = await supabaseAdmin.from('messages').select('custom_data').eq('id', saved.id).maybeSingle();
  if (current.error || current.data?.custom_data?.native_media_delivery?.id !== attempt.id) {
    throw new OutboundMediaError('Media receipt requires reconciliation');
  }
  const metadata = current.data.custom_data;
  const next = { ...metadata, status: accepted.skipped ? 'skipped' : accepted.status || 'sent',
    native_media_delivery: { ...attempt, state: accepted.skipped ? 'skipped' : 'accepted' },
    ...(!accepted.skipped ? { provider_message_id: accepted.id, sent_at: new Date().toISOString() } : {}),
  };
  const updated = await supabaseAdmin.from('messages').update({ custom_data: next })
    .eq('id', saved.id).eq('custom_data', JSON.stringify(metadata)).select('id').maybeSingle();
  if (updated.error || !updated.data) throw new OutboundMediaError('Media receipt persistence requires reconciliation');
  return result;
}