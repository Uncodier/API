import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { findSettingsForSender } from './webhook-handlers';

const db = () => supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
  || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');

export function isWhatsAppAppEcho(event: any): boolean {
  return event?.type === 'message.sent' && event.data?.source === 'whatsapp_business_app';
}

function eventTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return eventTime(Number(value));
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/** Only signature-verified, durably claimed events may call this handler. */
export async function handleWhatsAppAppEcho(event: any, now = Date.now()): Promise<void> {
  const data = event?.data;
  if (!isWhatsAppAppEcho(event) || data.direction !== 'outbound' || data.channel !== 'whatsapp') return;
  if (data.isHistory === true || data.isHistorical === true || data.history === true) return;
  const timestamp = eventTime(data.providerTimestamp ?? data.timestamp ?? data.sentAt ?? event.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8.64e15) return;
  const createdAt = new Date(Math.min(timestamp, now)).toISOString();
  const senderIds = [event.senderId, data.senderId, event.sender?.id].filter(value => value != null);
  const senderId = senderIds[0];
  if (typeof senderId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(senderId)
      || senderIds.some(value => value !== senderId)) return;
  const providerId = data.messageId;
  if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 200) return;
  // No suffix matching, local-number guessing, group IDs or arbitrary provider conversation IDs.
  if (typeof data.to !== 'string' || !/^(whatsapp:)?\+?[1-9]\d{6,14}$/.test(data.to)) return;
  const digits = data.to.replace(/^whatsapp:/, '').replace(/^\+/, '');
  const recipients = [digits, `+${digits}`, `whatsapp:${digits}`, `whatsapp:+${digits}`];
  const text = [data.text, data.body, data.caption].find(value => typeof value === 'string' && value.trim());
  const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact'];
  const content = text || (mediaTypes.includes(data.messageType) ? `[${data.messageType}]` : null);
  if (!content) return;

  const settings = await findSettingsForSender(senderId, { skipCache: true });
  if (settings.length !== 1 || typeof settings[0].site_id !== 'string') return;
  const siteId = settings[0].site_id;
  const connections = settings[0].channels?.connections;
  const matches = Array.isArray(connections) ? connections.filter((row: any) =>
    row.zavu_sender_id === senderId && row.type === 'whatsapp') : [];
  if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) return;
  const connectionId = matches[0].id;
  const hex = createHash('sha256').update(JSON.stringify([
    'zavu-whatsapp-app-echo-v1', siteId, connectionId, senderId, providerId,
  ])).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const readExisting = async () => {
    const { data: row, error } = await db().from('messages')
      .select('id, role, user_id, content, custom_data, conversations!inner(site_id)')
      .eq('id', id).eq('conversations.site_id', siteId).maybeSingle();
    if (error) throw new Error('ZAVU_APP_ECHO_LOOKUP_FAILED');
    if (row && (row.role !== 'team_member' || row.user_id !== null || row.content !== content
        || row.custom_data?.external_message_id !== providerId || row.custom_data?.connection_id !== connectionId
        || row.custom_data?.zavu_sender_id !== senderId || !recipients.includes(row.custom_data?.zavu_from)
        || row.custom_data?.source !== 'whatsapp_business_app')) throw new Error('ZAVU_APP_ECHO_SCOPE_CONFLICT');
    return row;
  };
  if (await readExisting()) return;

  // Match the latest inbound for each exact representation; ambiguous conversations fail closed.
  const candidates = [];
  for (const from of recipients) {
    const { data: row, error } = await db().from('messages')
      .select('conversation_id, custom_data, conversations!inner(site_id)')
      .eq('conversations.site_id', siteId).eq('role', 'user')
      .eq('custom_data->>connection_id', connectionId).eq('custom_data->>zavu_sender_id', senderId)
      .eq('custom_data->>zavu_from', from)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error('ZAVU_APP_ECHO_CONVERSATION_LOOKUP_FAILED');
    if (row?.conversation_id) candidates.push(row);
  }
  // The first inbound workflow may still be saving its conversation. Let durable
  // webhook retries resolve that race, never create a speculative conversation.
  if (!candidates.length) throw new Error('ZAVU_APP_ECHO_CONVERSATION_NOT_READY');
  if (new Set(candidates.map(row => row.conversation_id)).size !== 1) return;
  const row = {
    id, conversation_id: candidates[0].conversation_id, role: 'team_member', user_id: null,
    content, created_at: createdAt,
    custom_data: {
      source: 'whatsapp_business_app', origin: 'zavu', external_human: true,
      external_message_id: providerId, origin_message_id: providerId,
      connection_id: connectionId, zavu_sender_id: senderId, zavu_from: candidates[0].custom_data.zavu_from,
      channel: 'whatsapp', direction: 'outbound', provider_event_at: new Date(timestamp).toISOString(),
      ...(mediaTypes.includes(data.messageType) ? { message_type: data.messageType } : {}),
    },
  };
  // Insert, never upsert: duplicate events must not re-fire the human-reply snooze trigger.
  const { error } = await db().from('messages').insert(row);
  if (!error) return;
  if (error.code !== '23505') throw new Error('ZAVU_APP_ECHO_SAVE_FAILED');
  if (!await readExisting()) throw new Error('ZAVU_APP_ECHO_SCOPE_CONFLICT');
}