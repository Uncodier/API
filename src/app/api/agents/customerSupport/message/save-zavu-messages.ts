import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { usableSupportContent } from './response-content';
import type { ResponseFormat } from '@/lib/services/channels/response-format';

export function supportRecordId(parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Input = {
  siteId: string; userId: string; agentId?: string; leadId?: string;
  conversationId?: string; conversationTitle?: string; commandId?: string;
  userMessage: string; assistantMessage: string; originMessageId: string;
  channel: string; requireApproval?: boolean; metadata: Record<string, unknown>;
  responseFormat?: ResponseFormat;
  inboundOnly?: boolean;
};

/** Stable PKs make concurrent and partial writes recoverable without overwriting messages. */
export function saveZavuSupportMessages(input: Input & { inboundOnly: true }): Promise<{
  conversationId: string; userMessageId: string; assistantMessageId: undefined; conversationTitle?: string; automationStartedAt: string;
}>;
export function saveZavuSupportMessages(input: Input & { inboundOnly?: false }): Promise<{
  conversationId: string; userMessageId: string; assistantMessageId: string; conversationTitle?: string;
}>;
export async function saveZavuSupportMessages(input: Input): Promise<{
  conversationId: string; userMessageId: string; assistantMessageId: string | undefined; conversationTitle?: string; automationStartedAt?: string;
}> {
  const receivedAt = new Date().toISOString();
  if (!input.inboundOnly && !usableSupportContent(input.assistantMessage)) throw new Error('CUSTOMER_SUPPORT_EMPTY_RESPONSE');
  const connection = input.metadata.connection_id;
  const sender = input.metadata.zavu_sender_id;
  const from = input.metadata.zavu_from;
  if (typeof connection !== 'string' || !connection || typeof sender !== 'string' || !sender
      || typeof from !== 'string' || !from || !input.originMessageId) {
    throw new Error('CUSTOMER_SUPPORT_INBOUND_SCOPE_REQUIRED');
  }
  const db = () => supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
  const scope = [input.siteId, connection, input.originMessageId];
  const userId = supportRecordId(['support-inbound-v1', ...scope]);
  const assistantId = supportRecordId(['support-reply-v1', ...scope]);
  // Prefer a previously saved inbound (including pre-fix records) over a new conversation.
  const { data: previous, error: lookupError } = await db().from('messages')
    .select('id, conversation_id, content, created_at, custom_data, conversations!inner(site_id)')
    .eq('conversations.site_id', input.siteId).eq('role', 'user')
    .eq('custom_data->>connection_id', connection)
    .eq('custom_data->>origin_message_id', input.originMessageId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (lookupError) throw new Error('CUSTOMER_SUPPORT_INBOUND_LOOKUP_FAILED');
  if (previous && (previous.content !== input.userMessage
      || previous.custom_data?.zavu_sender_id !== sender || previous.custom_data?.zavu_from !== from)) {
    throw new Error('CUSTOMER_SUPPORT_INBOUND_SCOPE_CONFLICT');
  }
  const conversationId = previous?.conversation_id || input.conversationId
    || supportRecordId(['support-conversation-v1', input.siteId, connection, from]);
  const { data: existingConversation, error: conversationError } = await db().from('conversations')
    .select('id, site_id').eq('id', conversationId).maybeSingle();
  if (conversationError) throw new Error('CUSTOMER_SUPPORT_CONVERSATION_LOOKUP_FAILED');
  if (existingConversation && existingConversation.site_id !== input.siteId) {
    throw new Error('CUSTOMER_SUPPORT_CONVERSATION_SCOPE_CONFLICT');
  }
  if (!existingConversation) {
    const { error } = await db().from('conversations').insert({
      id: conversationId, site_id: input.siteId, user_id: input.userId,
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.leadId ? { lead_id: input.leadId } : {}),
      ...(input.conversationTitle ? { title: input.conversationTitle } : {}),
      channel: input.channel, custom_data: { channel: input.channel, channel_delivery: true },
    });
    if (error) {
      if (error.code !== '23505') throw new Error('CUSTOMER_SUPPORT_CONVERSATION_SAVE_FAILED');
      const { data: winner, error: readError } = await db().from('conversations')
        .select('site_id').eq('id', conversationId).maybeSingle();
      if (readError || winner?.site_id !== input.siteId) throw new Error('CUSTOMER_SUPPORT_CONVERSATION_SCOPE_CONFLICT');
    }
  }
  const inboundId = previous?.id || userId;
  let automationStartedAt = previous?.created_at || receivedAt;
  const shared = { conversation_id: conversationId,
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    ...(input.leadId ? { lead_id: input.leadId } : {}),
    ...(input.commandId ? { command_id: input.commandId } : {}),
  };
  const rows = [
    ...(!previous ? [{ ...shared, id: userId, role: 'user', user_id: input.userId, created_at: receivedAt,
      content: input.userMessage, custom_data: { ...input.metadata, origin_message_id: input.originMessageId } }] : []),
    ...(!input.inboundOnly ? [{ ...shared, id: assistantId, role: 'assistant', user_id: null, content: input.assistantMessage,
      custom_data: { connection_id: connection, origin_message_id: input.originMessageId,
        ...(typeof input.metadata.automation_started_at === 'string'
          ? { automation_started_at: input.metadata.automation_started_at } : {}),
        response_format: input.responseFormat || 'text',
        reply_to_message_id: inboundId, ...(input.requireApproval ? { status: 'pending', channel: input.channel } : {}) } }] : []),
  ];
  for (const row of rows) {
    const { error } = await db().from('messages').insert(row);
    if (!error) continue;
    if (error.code !== '23505') throw new Error('CUSTOMER_SUPPORT_MESSAGE_SAVE_FAILED');
    const { data: existing, error: readError } = await db().from('messages')
      .select('id, role, conversation_id, content, created_at, custom_data').eq('id', row.id).maybeSingle();
    if (readError || !existing || existing.role !== row.role || existing.conversation_id !== conversationId
        || existing.content !== row.content || existing.custom_data?.connection_id !== connection
        || existing.custom_data?.origin_message_id !== input.originMessageId
        || (row.role === 'assistant' && (existing.custom_data?.response_format || 'text') !== (input.responseFormat || 'text'))) {
      throw new Error('CUSTOMER_SUPPORT_MESSAGE_SCOPE_CONFLICT');
    }
    if (row.role === 'user' && existing.created_at) automationStartedAt = existing.created_at;
  }
  return { conversationId, userMessageId: inboundId, assistantMessageId: input.inboundOnly ? undefined : assistantId,
    ...(input.inboundOnly ? { automationStartedAt } : {}),
    conversationTitle: input.conversationTitle };
}