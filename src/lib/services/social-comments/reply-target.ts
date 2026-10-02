import { supabaseAdmin } from '@/lib/database/supabase-client';
import { commentConversationId, commentMetadata, networkName, record, replyMetadata, SocialCommentError } from './metadata';

export async function loadCommentSource(siteId: string, conversationId: string, sourceMessageId: string) {
  const { data: conversation, error } = await supabaseAdmin.from('conversations')
    .select('id, site_id, channel, custom_data').eq('id', conversationId).eq('site_id', siteId).maybeSingle();
  if (error) throw new SocialCommentError('Comment conversation lookup failed', 503);
  if (!conversation || conversation.custom_data?.source === 'outstand_dm'
    || conversation.custom_data?.outstand_conversation_id) throw new SocialCommentError('Comment conversation mismatch', 400);
  const { data: source, error: sourceError } = await supabaseAdmin.from('messages')
    .select('id, role, custom_data').eq('id', sourceMessageId).eq('conversation_id', conversationId)
    .eq('role', 'user').maybeSingle();
  if (sourceError) throw new SocialCommentError('Comment source lookup failed', 503);
  if (!source) throw new SocialCommentError('Reply target must be an inbound comment in this conversation', 400);
  const metadata = commentMetadata(source.custom_data, conversation.channel);
  if (!metadata) throw new SocialCommentError('Reply target is not a comment', 400);
  if (conversation.custom_data?.comment_grouping_version === 1
    && commentConversationId(siteId, metadata) !== conversation.id) {
    throw new SocialCommentError('Reply target does not match the grouped conversation');
  }
  return { source, metadata };
}

export async function interventionCommentMetadata(input: {
  siteId: string; conversationId: string; conversationData: unknown; replyToMessageId?: string;
  retryMessageId?: string; userId: string;
}): Promise<Record<string, any> | undefined> {
  const conversation = record(input.conversationData);
  let sourceId = input.replyToMessageId;
  let saved: Record<string, any> | undefined;
  if (input.retryMessageId) {
    const { data, error } = await supabaseAdmin.from('messages').select('custom_data')
      .eq('id', input.retryMessageId).eq('conversation_id', input.conversationId)
      .eq('role', 'team_member').eq('user_id', input.userId).maybeSingle();
    if (error) throw new SocialCommentError('Reply retry lookup failed', 503);
    if (!data) throw new SocialCommentError('Reply retry message not found', 400);
    saved = record(data.custom_data);
    if (sourceId && sourceId !== saved.reply_to_message_id) throw new SocialCommentError('Reply target cannot change on retry');
    sourceId = saved.reply_to_message_id;
  }
  if (sourceId) {
    const { metadata } = await loadCommentSource(input.siteId, input.conversationId, sourceId);
    const result = replyMetadata(metadata, sourceId);
    if (saved && ['reply_to_message_id', 'reply_to_comment_id', 'outstand_post_id', 'publisher_account_id', 'network', 'author_id', 'platform_post_id']
      .some(key => saved?.[key] !== result[key])) throw new SocialCommentError('Saved reply target no longer matches its source');
    return saved || result;
  }
  if (conversation.source === 'comment') throw new SocialCommentError('reply_to_message_id is required for a comment reply', 400);
  // Legacy conversations have no discriminator. Detect presence, never select a target by recency.
  if (!conversation.outstand_conversation_id && conversation.source !== 'outstand_dm') {
    const { data, error } = await supabaseAdmin.from('messages').select('id')
      .eq('conversation_id', input.conversationId).eq('role', 'user')
      .eq('custom_data->>source', 'comment').limit(1);
    if (error) throw new SocialCommentError('Comment context lookup failed', 503);
    if (data?.length) throw new SocialCommentError('Select an explicit inbound comment before replying', 400);
  }
  return undefined;
}

export async function loadSavedCommentReply(siteId: string, conversationId: string, messageId: string, channel: string) {
  const { data: outgoing, error } = await supabaseAdmin.from('messages')
    .select('id, content, role, custom_data').eq('conversation_id', conversationId).eq('id', messageId).maybeSingle();
  if (error) throw new SocialCommentError('Saved reply lookup failed', 503);
  const saved = record(outgoing?.custom_data);
  if (!outgoing || !['assistant', 'team_member'].includes(outgoing.role)
    || saved.source !== 'comment' || typeof saved.reply_to_message_id !== 'string') {
    throw new SocialCommentError('Saved comment reply requires an explicit source message');
  }
  const { metadata } = await loadCommentSource(siteId, conversationId, saved.reply_to_message_id);
  const expected = replyMetadata(metadata, saved.reply_to_message_id);
  if (networkName(channel) !== metadata.network
    || ['reply_to_comment_id', 'publisher_account_id', 'outstand_post_id', 'network', 'platform_post_id', 'author_id']
      .some(key => saved[key] !== expected[key])) throw new SocialCommentError('Saved comment reply target mismatch');
  return { outgoing, saved, metadata };
}