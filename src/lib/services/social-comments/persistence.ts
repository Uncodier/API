import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { commentConversationId, record, replyMetadata, sameCommentScope, SocialCommentError } from './metadata';

export function commentMessageIds(conversationId: string, platformCommentId: string) {
  const userMessageId = uuidv5(JSON.stringify(['social-comment-inbound-v1', conversationId, platformCommentId]), uuidv5.URL);
  return { userMessageId, assistantMessageId: uuidv5(`social-comment-proposal-v1:${userMessageId}`, uuidv5.URL) };
}

export async function findCommentProposal(siteId: string, metadata: Record<string, any>) {
  const conversationId = commentConversationId(siteId, metadata);
  const ids = commentMessageIds(conversationId, metadata.platform_comment_id);
  const { data, error } = await supabaseAdmin.from('messages').select('id, custom_data')
    .eq('conversation_id', conversationId).eq('id', ids.assistantMessageId).maybeSingle();
  if (error) throw new SocialCommentError('Comment proposal lookup failed', 503);
  if (data && (!sameCommentScope(record(data.custom_data), metadata)
    || data.custom_data?.reply_to_message_id !== ids.userMessageId
    || data.custom_data?.reply_to_comment_id !== metadata.platform_comment_id)) {
    throw new SocialCommentError('Comment proposal target conflict');
  }
  return data ? { conversationId, ...ids } : null;
}

/** Deterministic message PKs recover partial saves without reparenting or overwriting a pending proposal. */
export async function saveCommentMessages(input: {
  siteId: string; conversationId: string; userId: string; userMessage: string; assistantMessage: string;
  metadata: Record<string, any>; leadId?: string; agentId?: string; commandId?: string; conversationTitle?: string;
}) {
  const { metadata, conversationId, siteId } = input;
  if (conversationId !== commentConversationId(siteId, metadata)) throw new SocialCommentError('Comment scope mismatch');
  const ids = commentMessageIds(conversationId, metadata.platform_comment_id);
  const shared = {
    conversation_id: conversationId,
    ...(input.leadId ? { lead_id: input.leadId } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    ...(input.commandId ? { command_id: input.commandId } : {}),
  };
  const rows = [
    { ...shared, id: ids.userMessageId, role: 'user', user_id: input.userId,
      content: input.userMessage, custom_data: metadata },
    { ...shared, id: ids.assistantMessageId, role: 'assistant', user_id: null,
      content: input.assistantMessage,
      custom_data: { ...replyMetadata(metadata, ids.userMessageId), status: 'pending' } },
  ];
  for (const row of rows) {
    const { error } = await supabaseAdmin.from('messages').insert(row);
    if (error) {
      if (error.code !== '23505') throw new SocialCommentError('Comment messages could not be saved', 503);
      const { data: existing, error: loadError } = await supabaseAdmin.from('messages')
        .select('id, role, custom_data').eq('conversation_id', conversationId).eq('id', row.id).maybeSingle();
      if (loadError || !existing || existing.role !== row.role
        || !sameCommentScope(record(existing.custom_data), metadata)
        || (row.role === 'user' && existing.custom_data?.platform_comment_id !== metadata.platform_comment_id)
        || (row.role === 'assistant' && (existing.custom_data?.reply_to_message_id !== ids.userMessageId
          || existing.custom_data?.reply_to_comment_id !== metadata.platform_comment_id))) {
        throw new SocialCommentError('Comment message conflict could not be resolved', 503);
      }
    }
  }
  return { conversationId, ...ids, conversationTitle: input.conversationTitle };
}