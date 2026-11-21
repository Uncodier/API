import { matchesZavuThread } from './zavu-thread-scope';
import { pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { getSiteLicensedResources, isLicensedChannelConnection } from '@/lib/billing/licensed-resources';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { inboundZavuRecipient } from '../zavu/inbound-recipient';
import type { SavedSendScope } from './automation-send-guard';

const present = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const conflict = () => Object.assign(new Error('Saved channel reply does not match its inbound destination'), { status: 409 });

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ExpectedZavuTurn {
  connectionId: unknown; senderId: unknown; from: unknown; channel: unknown; eventId?: unknown;
}

export interface SavedZavuBinding {
  siteId: string; conversationId: string; messageId: string; inboundMessageId: string;
  channel: string; recipient: string; from: string; connectionId: string; senderId: string; eventId: string;
}

/** Immutable fields shared by the dispatch claim and the signed receipt handler. */
export function zavuAttemptScope(b: SavedZavuBinding) {
  return { provider: 'zavu' as const, site_id: b.siteId, conversation_id: b.conversationId, message_id: b.messageId,
    inbound_message_id: b.inboundMessageId, channel: b.channel, recipient: b.recipient, zavu_from: b.from,
    connection_id: b.connectionId, sender_id: b.senderId, origin_message_id: b.eventId };
}

export function sameZavuBinding(expected: SavedZavuBinding, current: SavedZavuBinding | undefined): boolean {
  return !!current && (Object.keys(expected) as (keyof SavedZavuBinding)[]).every(key => expected[key] === current[key]);
}

export async function requirePinnedZavuSender(binding: SavedZavuBinding) {
  const { channels: { connections } } = await getSiteLicensedResources(binding.siteId);
  const ids = connections.filter(row => row.id === binding.connectionId);
  const senders = connections.filter(row => row.type === binding.channel && row.zavu_sender_id === binding.senderId);
  if (ids.length !== 1 || senders.length !== 1 || ids[0].zavu_sender_id !== binding.senderId
    || !isLicensedChannelConnection(binding.channel, ids[0])) throw conflict();
}

function pinnedMediaAttempt(value: unknown): boolean {
  // A generic native-media attempt does not identify an inbound turn. Even a
  // damaged pinned claim must not fall back to Outstand or a site's first sender.
  return object(value) && ['inbound_message_id', 'origin_message_id', 'sender_id', 'zavu_from'].some(key => key in value);
}

/** Only persisted message links determine the provider, account and recipient.
 * A worker hint may require this check but can never supply a destination. */
export async function savedZavuReply(scope: SavedSendScope | undefined, request: {
  site_id: string; channel: string; to: string; message?: string; message_id?: string; expectedZavuTurn?: ExpectedZavuTurn;
  response_format?: string; media_url?: string; message_type?: string; mime_type?: string;
}): Promise<SavedZavuBinding | undefined> {
  const reply = scope?.message;
  const data = reply?.custom_data;
  const linked = data && 'origin_message_id' in data && ('connection_id' in data || 'reply_to_message_id' in data);
  const mediaClaim = pinnedMediaAttempt(data?.native_media_delivery);
  if (!request.expectedZavuTurn && !data?.pinned_text_delivery && !mediaClaim
    && !(reply?.role === 'assistant' && linked && data?.source !== 'comment')) return;
  // Legacy rows may only carry custom_data.channel. Do not resolve conflicting
  // evidence by picking one of the two, and never use a request hint as a fallback.
  if (!scope || !data || !present(request.message_id) || reply?.role !== 'assistant'
    || !present(data.connection_id) || !present(data.reply_to_message_id) || !present(data.origin_message_id)
    || !matchesZavuThread(scope.channel, scope.conversationData, request.channel)
    || (data.channel !== undefined && data.channel !== request.channel)
    || (typeof data.source === 'string' && data.source.includes('comment'))
    || reply.content !== (request.message ?? '') || data.media_url !== request.media_url
    || (data.media_url !== undefined && (data.message_type !== request.message_type || data.mime_type !== request.mime_type))
    || (data.response_format ?? 'text') !== (request.response_format ?? 'text')
    || ['pending', 'rejected', 'declined', 'cancelled', 'skipped'].includes(String(data.status))) throw conflict();

  const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
  const { data: inbound, error } = await db.from('messages').select('custom_data, conversations!inner(site_id)')
    .eq('id', data.reply_to_message_id).eq('role', 'user').eq('conversation_id', scope.conversationId)
    .eq('conversations.site_id', request.site_id).maybeSingle();
  if (error) throw Object.assign(new Error('Unable to verify the inbound channel message'), { status: 503 });
  const origin = inbound?.custom_data;
  if (origin?.source !== 'zavu_inbound_message' || origin.connection_id !== data.connection_id
    || origin.channel !== request.channel || origin.origin_message_id !== data.origin_message_id
    || !present(origin.zavu_sender_id) || !present(origin.zavu_from)
    || inboundZavuRecipient(origin.zavu_from) !== request.to) throw conflict();
  const expected = request.expectedZavuTurn;
  if (expected && (expected.connectionId !== data.connection_id || expected.senderId !== origin.zavu_sender_id
    || expected.channel !== request.channel || expected.from !== origin.zavu_from
    || (expected.eventId !== undefined && expected.eventId !== data.origin_message_id))) throw conflict();
  const binding = { siteId: request.site_id, conversationId: scope.conversationId, messageId: request.message_id,
    channel: request.channel, recipient: request.to, inboundMessageId: data.reply_to_message_id,
    connectionId: data.connection_id, senderId: origin.zavu_sender_id as string, from: origin.zavu_from as string, eventId: data.origin_message_id };
  // The row's current links alone cannot authorize an attempt recorded for a
  // different reply, sender, or inbound turn, including two turns on the same account.
  if (data.pinned_text_delivery || mediaClaim) {
    const attempt = data.pinned_text_delivery ?? data.native_media_delivery;
    if (!object(attempt) || Boolean(data.media_url) !== mediaClaim || (mediaClaim && data.pinned_text_delivery)
      || attempt.payload_hash !== pinnedReplyPayloadHash(reply.content, data)
      || Object.entries(zavuAttemptScope(binding)).some(([key, value]) => attempt[key] !== value)) throw conflict();
  }
  return binding;
}