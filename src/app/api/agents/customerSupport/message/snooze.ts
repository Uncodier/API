import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { supportRecordId } from './save-zavu-messages';

const db = () => supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
  || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');

export type SupportSnoozeInput = {
  siteId?: string; conversationId?: string; userId: string; message: string;
  leadId?: string; visitorId?: string; agentId?: string; originMessageId?: string;
  metadata?: Record<string, unknown>; startedAt: string;
  persistedInboundId?: string;
};

/** Resolve Zavu by its exact connection/contact, not the site's latest conversation. */
export async function resolveSnoozeConversation(input: {
  siteId?: string; conversationId?: string; metadata?: Record<string, unknown>;
}): Promise<string | undefined> {
  const metadata = input.metadata;
  if (metadata?.source !== 'zavu_inbound_message') return input.conversationId;
  if (!input.siteId || typeof metadata.connection_id !== 'string'
      || typeof metadata.zavu_sender_id !== 'string' || typeof metadata.zavu_from !== 'string') {
    throw new Error('CUSTOMER_SUPPORT_INBOUND_SCOPE_REQUIRED');
  }
  const { data, error } = await db().from('messages')
    .select('conversation_id, conversations!inner(site_id)')
    .eq('conversations.site_id', input.siteId).eq('role', 'user')
    .eq('custom_data->>connection_id', metadata.connection_id)
    .eq('custom_data->>zavu_sender_id', metadata.zavu_sender_id)
    .eq('custom_data->>zavu_from', metadata.zavu_from)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('CUSTOMER_SUPPORT_SNOOZE_LOOKUP_FAILED');
  return data?.conversation_id || supportRecordId([
    'support-conversation-v1', input.siteId, metadata.connection_id, metadata.zavu_from,
  ]);
}

export async function readSupportSnooze(input: {
  siteId?: string; conversationId?: string; startedAt: string;
  originMessageId?: string; metadata?: Record<string, unknown>;
}) {
  if (!input.conversationId) return null;
  if (!input.siteId) throw new Error('CUSTOMER_SUPPORT_SNOOZE_SITE_REQUIRED');
  const { data, error } = await db().from('conversations')
    .select('id, site_id, automation_paused_until, last_human_reply_at')
    .eq('id', input.conversationId).eq('site_id', input.siteId).maybeSingle();
  if (error) throw new Error('CUSTOMER_SUPPORT_SNOOZE_LOOKUP_FAILED');
  if (!data) return null;
  // A skipped inbound is terminal. A delayed workflow retry must not answer it
  // after the pause expires (only a genuinely new customer turn can resume).
  if (input.originMessageId) {
    let lookup = db().from('messages').select('id')
      .eq('conversation_id', input.conversationId).eq('role', 'user')
      .eq('custom_data->>origin_message_id', input.originMessageId)
      .eq('custom_data->>skip_reason', 'agent_snoozed');
    if (typeof input.metadata?.connection_id === 'string') {
      lookup = lookup.eq('custom_data->>connection_id', input.metadata.connection_id);
    }
    const { data: receipt, error: receiptError } = await lookup.limit(1).maybeSingle();
    if (receiptError) throw new Error('CUSTOMER_SUPPORT_SNOOZE_LOOKUP_FAILED');
    if (receipt) return { conversationId: data.id as string, pausedUntil: data.automation_paused_until as string | null };
  }
  const paused = Date.parse(data.automation_paused_until || '') > Date.now();
  const superseded = Date.parse(data.last_human_reply_at || '') >= Date.parse(input.startedAt);
  return paused || superseded ? {
    conversationId: data.id as string,
    pausedUntil: data.automation_paused_until as string | null,
  } : null;
}

/** Store only the customer's input. No assistant placeholder and no assignment updates. */
export async function saveSnoozedSupportInput(input: SupportSnoozeInput,
  state: { conversationId: string; pausedUntil: string | null }) {
  const connection = input.metadata?.connection_id;
  const id = input.persistedInboundId || (input.originMessageId
    ? supportRecordId(typeof connection === 'string' && input.metadata?.source === 'zavu_inbound_message'
      ? ['support-inbound-v1', input.siteId!, connection, input.originMessageId]
      : ['snoozed-inbound-v1', input.siteId!, state.conversationId, input.originMessageId])
    : randomUUID());
  const row = {
    id, conversation_id: state.conversationId, user_id: input.userId,
    content: input.message, role: 'user',
    ...(input.leadId ? { lead_id: input.leadId } : {}),
    ...(input.visitorId ? { visitor_id: input.visitorId } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    custom_data: { ...input.metadata,
      ...(input.originMessageId ? { origin_message_id: input.originMessageId } : {}),
      response_skipped: true, automation_paused: true, skip_reason: 'agent_snoozed',
    },
  };
  const { error } = await db().from('messages').insert(row);
  if (error) {
    if (error.code !== '23505') throw new Error('CUSTOMER_SUPPORT_SNOOZE_PERSISTENCE_FAILED');
    const { data: previous, error: lookupError } = await db().from('messages')
      .select('conversation_id, role, content, custom_data, updated_at').eq('id', id).maybeSingle();
    if (lookupError || previous?.conversation_id !== state.conversationId
        || previous?.role !== 'user' || previous?.content !== input.message) {
      throw new Error('CUSTOMER_SUPPORT_SNOOZE_SCOPE_CONFLICT');
    }
    if (previous.custom_data?.skip_reason !== 'agent_snoozed') {
      let update = db().from('messages').update({ custom_data: {
        ...previous.custom_data, response_skipped: true, automation_paused: true, skip_reason: 'agent_snoozed',
      } }).eq('id', id).eq('conversation_id', state.conversationId).eq('role', 'user');
      if (previous.updated_at) update = update.eq('updated_at', previous.updated_at);
      const { data: marked, error: updateError } = await update.select('id').maybeSingle();
      if (updateError || !marked) throw new Error('CUSTOMER_SUPPORT_SNOOZE_PERSISTENCE_FAILED');
    }
  }
  return { success: true, data: {
    automation_paused: true, skipped: true, response_skipped: true, reason: 'agent_snoozed',
    automation_paused_until: state.pausedUntil, conversation_id: state.conversationId,
    site_id: input.siteId, lead_id: input.leadId || null,
    messages: { user: { content: input.message, message_id: id } },
  } };
}