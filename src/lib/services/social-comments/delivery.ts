import { supabaseAdmin } from '@/lib/database/supabase-client';
import { authorizeCommentAccount } from './ownership';
import { loadSavedCommentReply } from './reply-target';
import { SocialCommentError } from './metadata';

export async function sendCommentReply(params: {
  site_id: string; conversation_id?: string; message_id?: string; channel: string; message: string;
}) {
  if (!params.conversation_id || !params.message_id) throw new SocialCommentError('Comment delivery requires a saved outgoing message');
  const { outgoing, saved, metadata } = await loadSavedCommentReply(
    params.site_id, params.conversation_id, params.message_id, params.channel,
  );
  if (outgoing.content !== params.message) throw new SocialCommentError('Reply content differs from the saved message');
  if (saved.comment_delivery_status === 'sent' && saved.provider_message_id) {
    return { success: true, messageId: saved.provider_message_id as string, deliveryKind: 'comment' as const };
  }
  if (saved.comment_delivery_status) throw new SocialCommentError('Comment delivery already claimed or requires reconciliation');
  if (outgoing.role === 'assistant' && !['accepted', 'sending'].includes(saved.status)) {
    throw new SocialCommentError('A proposed public reply requires approval before delivery');
  }
  const { client, username, platformPostId } = await authorizeCommentAccount(params.site_id, metadata);
  const claimed = { ...saved, comment_delivery_status: 'sending' };
  const { data, error } = await supabaseAdmin.from('messages').update({ custom_data: claimed })
    .eq('id', outgoing.id).eq('conversation_id', params.conversation_id)
    .eq('content', outgoing.content)
    .eq('custom_data', JSON.stringify(saved)).select('id').maybeSingle();
  if (error || !data) throw new SocialCommentError('Comment reply delivery could not be claimed');
  let result;
  try {
    result = await client.publishComment(metadata.outstand_post_id, {
      content: outgoing.content, network: metadata.network, platform_post_id: platformPostId || undefined,
      parent_comment_id: saved.reply_to_comment_id, account_username: username,
    }, params.site_id);
    if (result.success !== true || !result.reply_id) throw new Error('Unconfirmed comment delivery');
  } catch {
    await supabaseAdmin.from('messages').update({ custom_data: { ...claimed, comment_delivery_status: 'unknown' } })
      .eq('id', outgoing.id).eq('conversation_id', params.conversation_id).eq('custom_data', JSON.stringify(claimed));
    throw new SocialCommentError('Comment delivery is unconfirmed; reconcile before retrying');
  }
  const { data: completed, error: saveError } = await supabaseAdmin.from('messages').update({ custom_data: {
    ...saved, comment_delivery_status: 'sent', status: 'sent', provider_message_id: result.reply_id,
    sent_at: new Date().toISOString(),
  } }).eq('id', outgoing.id).eq('conversation_id', params.conversation_id)
    .eq('custom_data', JSON.stringify(claimed)).select('id').maybeSingle();
  if (saveError || !completed) throw new SocialCommentError('Comment sent but receipt requires reconciliation');
  return { success: true, messageId: result.reply_id, deliveryKind: 'comment' as const };
}