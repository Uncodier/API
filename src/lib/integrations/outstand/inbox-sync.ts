import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getOutstandClient } from './client';
import type {
  OutstandConversation,
  OutstandConversationMessage,
} from './types';
import type { OutstandWebhookPayload } from './webhook-types';

type InboxWebhookPayload = Extract<
  OutstandWebhookPayload,
  {
    event:
      | 'conversation.started'
      | 'message.received'
      | 'message.sent'
      | 'message.failed';
  }
>;

async function findTenantId(socialAccountId: string): Promise<string> {
  const client = getOutstandClient();
  const limit = 100;

  for (let offset = 0; ; offset += limit) {
    const response = await client.listAccounts(undefined, {
      network: 'instagram',
      limit,
      offset,
    });
    const accounts = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.accounts)
        ? response.accounts
        : [];
    const account = accounts.find((item: { id?: string }) => item.id === socialAccountId);
    if (account?.tenant_id) return account.tenant_id;

    const total = typeof response?.total === 'number' ? response.total : accounts.length;
    if (accounts.length < limit || offset + accounts.length >= total) break;
  }

  throw new Error(`No tenant mapping found for Outstand account ${socialAccountId}`);
}

async function findLocalConversation(siteId: string, outstandConversationId: string) {
  return supabaseAdmin
    .from('conversations')
    .select('id, user_id, custom_data')
    .eq('site_id', siteId)
    .eq('channel', 'instagram')
    .filter('custom_data->>outstand_conversation_id', 'eq', outstandConversationId)
    .maybeSingle();
}

async function findSiteOwnerId(siteId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.user_id === 'string' ? data.user_id : null;
}

export async function ensureLocalOutstandConversation(
  conversation: OutstandConversation,
  siteId?: string,
): Promise<string> {
  const resolvedSiteId = siteId || await findTenantId(conversation.socialAccountId);
  const existing = await findLocalConversation(resolvedSiteId, conversation.id);
  if (existing.error) throw existing.error;

  const customData = {
    ...(existing.data?.custom_data || {}),
    source: 'outstand_dm',
    provider: 'outstand',
    channel_delivery: true,
    outstand_conversation_id: conversation.id,
    outstand_social_account_id: conversation.socialAccountId,
    outstand_platform_conversation_id: conversation.platformConversationId,
    outstand_participant_id: conversation.participantId,
    participant_display_name: conversation.participantDisplayName,
    participant_profile_picture: conversation.participantProfilePicture,
    unread_count: conversation.unreadCount,
  };

  if (existing.data) {
    const userId = existing.data.user_id || await findSiteOwnerId(resolvedSiteId);
    const { error } = await supabaseAdmin
      .from('conversations')
      .update({
        ...(userId ? { user_id: userId } : {}),
        status: conversation.status,
        is_archived: conversation.status === 'archived',
        custom_data: customData,
      })
      .eq('id', existing.data.id);
    if (error) throw error;
    return existing.data.id;
  }

  const userId = await findSiteOwnerId(resolvedSiteId);
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .insert([{
      site_id: resolvedSiteId,
      user_id: userId,
      channel: 'instagram',
      status: conversation.status,
      is_archived: conversation.status === 'archived',
      title: conversation.participantDisplayName || 'Instagram direct message',
      custom_data: customData,
      last_message_at: conversation.lastMessageAt,
    }])
    .select('id')
    .single();

  if (!error && data) return data.id;
  if ((error as { code?: string } | null)?.code === '23505') {
    const raced = await findLocalConversation(resolvedSiteId, conversation.id);
    if (!raced.error && raced.data) return raced.data.id;
  }
  throw error || new Error('Failed to create local Outstand conversation');
}

interface LocalMessageRecord {
  id: string;
  custom_data: Record<string, unknown> | null;
}

const TERMINAL_OUTSTAND_STATUSES = new Set(['sent', 'read', 'failed']);

export function reconcileOutstandStatus(
  currentStatus: unknown,
  incomingStatus: OutstandConversationMessage['status'],
): OutstandConversationMessage['status'] {
  if (
    incomingStatus === 'pending'
    && typeof currentStatus === 'string'
    && TERMINAL_OUTSTAND_STATUSES.has(currentStatus)
  ) {
    return currentStatus as OutstandConversationMessage['status'];
  }
  if (currentStatus === 'read' && incomingStatus === 'sent') return 'read';
  return incomingStatus;
}

async function findLocalMessageByProviderId(
  localConversationId: string,
  field: 'outstand_message_id' | 'provider_message_id',
  messageId: string,
) {
  return supabaseAdmin
    .from('messages')
    .select('id, custom_data')
    .eq('conversation_id', localConversationId)
    .filter(`custom_data->>${field}`, 'eq', messageId)
    .maybeSingle();
}

async function updateLocalOutstandMessage(
  existing: LocalMessageRecord,
  message: OutstandConversationMessage,
): Promise<boolean> {
  const currentStatus = existing.custom_data?.status;
  const customData = {
    ...(existing.custom_data || {}),
    source: 'outstand_dm',
    provider: 'outstand',
    channel: 'instagram',
    status: reconcileOutstandStatus(currentStatus, message.status),
    provider_message_id: message.id,
    outstand_message_id: message.id,
    outstand_conversation_id: message.conversationId,
    platform_message_id: message.platformMessageId,
    media_urls: message.mediaUrls,
    scheduled_at: message.scheduledAt,
    delivery_error: message.error,
  };

  let update = supabaseAdmin
    .from('messages')
    .update({ content: message.content || '', custom_data: customData })
    .eq('id', existing.id);
  if (typeof currentStatus === 'string') {
    update = update.filter('custom_data->>status', 'eq', currentStatus);
  }
  const { data, error } = await update.select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function recordOutstandMessage(
  message: OutstandConversationMessage,
  conversation: OutstandConversation,
  siteId?: string,
): Promise<void> {
  const localConversationId = await ensureLocalOutstandConversation(conversation, siteId);
  let existing = await findLocalMessageByProviderId(
    localConversationId,
    'outstand_message_id',
    message.id,
  );
  if (existing.error) throw existing.error;

  if (!existing.data && message.direction === 'outbound') {
    existing = await findLocalMessageByProviderId(
      localConversationId,
      'provider_message_id',
      message.id,
    );
    if (existing.error) throw existing.error;
  }

  if (existing.data) {
    const updated = await updateLocalOutstandMessage(existing.data, message);
    if (!updated) {
      const fresh = await findLocalMessageByProviderId(
        localConversationId,
        'outstand_message_id',
        message.id,
      );
      if (fresh.error) throw fresh.error;
      if (fresh.data) await updateLocalOutstandMessage(fresh.data, message);
    }
    return;
  }

  const customData = {
    source: 'outstand_dm',
    provider: 'outstand',
    channel: 'instagram',
    status: message.status,
    provider_message_id: message.id,
    outstand_message_id: message.id,
    outstand_conversation_id: message.conversationId,
    platform_message_id: message.platformMessageId,
    media_urls: message.mediaUrls,
    scheduled_at: message.scheduledAt,
    delivery_error: message.error,
  };
  const { error } = await supabaseAdmin.from('messages').insert([{
    conversation_id: localConversationId,
    content: message.content || '',
    role: message.direction === 'inbound' ? 'user' : 'assistant',
    created_at: message.platformSentAt || message.createdAt,
    custom_data: customData,
  }]);
  if (!error) return;
  if ((error as { code?: string }).code !== '23505') throw error;

  const raced = await findLocalMessageByProviderId(
    localConversationId,
    'outstand_message_id',
    message.id,
  );
  if (raced.error) throw raced.error;
  if (raced.data) await updateLocalOutstandMessage(raced.data, message);
}

export async function bindLocalOutstandMessage(input: {
  localMessageId: string;
  localConversationId: string;
  outstandConversationId: string;
  outstandMessageId: string;
}): Promise<void> {
  const { data: localMessage, error: localError } = await supabaseAdmin
    .from('messages')
    .select('id, custom_data')
    .eq('id', input.localMessageId)
    .eq('conversation_id', input.localConversationId)
    .maybeSingle();
  if (localError) throw localError;
  if (!localMessage) throw new Error('Local outbound message was not found');

  const initialCustomData = {
    ...(localMessage.custom_data || {}),
    provider_message_id: input.outstandMessageId,
    outstand_conversation_id: input.outstandConversationId,
    status: reconcileOutstandStatus(
      localMessage.custom_data?.status,
      'pending',
    ),
  };
  const { error: initialUpdateError } = await supabaseAdmin
    .from('messages')
    .update({ custom_data: initialCustomData })
    .eq('id', input.localMessageId);
  if (initialUpdateError) throw initialUpdateError;

  const duplicate = await findLocalMessageByProviderId(
    input.localConversationId,
    'outstand_message_id',
    input.outstandMessageId,
  );
  if (duplicate.error) throw duplicate.error;

  if (duplicate.data && duplicate.data.id !== input.localMessageId) {
    const { error: deleteError } = await supabaseAdmin
      .from('messages')
      .delete()
      .eq('id', duplicate.data.id);
    if (deleteError) throw deleteError;
  }

  const duplicateStatus = duplicate.data?.custom_data?.status;
  const finalCustomData = {
    ...(duplicate.data?.custom_data || {}),
    ...initialCustomData,
    source: 'outstand_dm',
    provider: 'outstand',
    channel: 'instagram',
    status: reconcileOutstandStatus(
      initialCustomData.status,
      typeof duplicateStatus === 'string'
        ? duplicateStatus as OutstandConversationMessage['status']
        : 'pending',
    ),
    outstand_message_id: input.outstandMessageId,
  };
  const { error: finalUpdateError } = await supabaseAdmin
    .from('messages')
    .update({ custom_data: finalCustomData })
    .eq('id', input.localMessageId);
  if (finalUpdateError) throw finalUpdateError;
}

export async function markLocalOutstandConversationRead(
  conversation: OutstandConversation,
  siteId?: string,
): Promise<void> {
  const localConversationId = await ensureLocalOutstandConversation(conversation, siteId);
  const { error } = await supabaseAdmin
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('conversation_id', localConversationId)
    .eq('role', 'user')
    .is('read_at', null);
  if (error) throw error;
}

export async function deleteLocalOutstandMessage(
  conversation: OutstandConversation,
  messageId: string,
  siteId?: string,
): Promise<void> {
  const localConversationId = await ensureLocalOutstandConversation(conversation, siteId);
  const { error } = await supabaseAdmin
    .from('messages')
    .delete()
    .eq('conversation_id', localConversationId)
    .filter('custom_data->>outstand_message_id', 'eq', messageId);
  if (error) throw error;
}

export async function syncOutstandInboxWebhook(
  payload: InboxWebhookPayload,
): Promise<void> {
  const client = getOutstandClient();
  const conversationResponse = await client.getConversation(payload.data.conversationId);
  const conversation = conversationResponse.conversation;

  if (payload.event === 'conversation.started') {
    await ensureLocalOutstandConversation(conversation);
    return;
  }

  const messagesResponse = await client.listConversationMessages(
    conversation.id,
    { limit: 200 },
  );
  const message = messagesResponse.data.find(
    (item) => item.id === payload.data.messageId,
  );
  if (!message) {
    throw new Error(`Outstand message ${payload.data.messageId} was not found for reconciliation`);
  }
  await recordOutstandMessage(message, conversation);
}
