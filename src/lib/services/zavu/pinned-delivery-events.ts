import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isChannelReplyAttemptId } from '@/lib/messaging/pinned-reply-payload';
import { isZavuAcceptedStatus, strongerZavuStatus, type ZavuReceiptStatus } from '@/lib/messaging/zavu-receipt-state';
import { savedZavuReply } from '../channels/saved-zavu-reply';
import { inboundBinding, inboundSender, type InboundBinding } from './inbound-claim';

const fields = ['pinned_text_delivery', 'native_media_delivery'] as const;
const select = 'id, conversation_id, role, content, custom_data, conversations!inner(site_id, channel, custom_data)';
const db = () => supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
const conflict = () => new Error('Pinned delivery evidence is inconsistent; receipt requires reconciliation');
const unavailable = () => new Error('Pinned delivery receipt store is unavailable');
const present = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

type EventFact = { senderId: string; channel: string; recipient: string; providerId: string; status: ZavuReceiptStatus; attemptId?: string };

function parse(event: any): EventFact | undefined {
  const data = event?.data;
  const status = typeof event?.type === 'string' && event.type.startsWith('message.') ? event.type.slice(8) : undefined;
  if (status !== 'failed' && !isZavuAcceptedStatus(status)) return;
  const senderId = inboundSender(event);
  const providerId = data?.messageId;
  const ids = [data?.metadata, event.metadata].filter(meta => meta && Object.hasOwn(meta, 'channel_reply_attempt'))
    .map(meta => meta.channel_reply_attempt);
  // A malformed or contradictory echo is not a missing echo. Do not fall back
  // to a provider-ID-only match in that case.
  if (ids.length && (!isChannelReplyAttemptId(ids[0]) || ids.some(id => id !== ids[0]))) throw conflict();
  if (!senderId || !/^[a-zA-Z0-9_-]{1,128}$/.test(senderId) || !present(data?.channel) || !present(data.to) || data.to.length > 500
    || !present(providerId) || providerId.length > 200 || providerId !== providerId.trim() || providerId.toLowerCase() === 'unknown'
    || /[\u0000-\u001f\u007f]/.test(providerId) || (data.direction != null && data.direction !== 'outbound')
    || (data.status != null && data.status !== status) || data.source === 'whatsapp_business_app') {
    if (ids.length) throw conflict();
    return;
  }
  return { senderId, channel: data.channel, recipient: data.to, providerId, status, attemptId: ids[0] };
}

async function resolveSender(fact: EventFact, verifiedSiteId?: string) {
  // Resolve the signed sender and channel from current settings; never use a
  // payload site hint, cached sender mapping, or a lookup at the provider.
  const { data, error } = await supabaseAdmin.from('settings').select('site_id, channels')
    .contains('channels', { connections: [{ zavu_sender_id: fact.senderId }] }).limit(2);
  if (error) throw unavailable();
  return inboundBinding(data || [], fact.senderId, fact.channel, verifiedSiteId);
}

async function candidates(siteId: string, fact: EventFact) {
  // PostgREST quoted literals escape quotes and backslashes. Property names and
  // operators are constants. Query both identities together: an echoed attempt
  // and a provider ID resolving to different records is not a match.
  const provider = JSON.stringify(fact.providerId);
  const filters = [`custom_data->>provider_message_id.eq.${provider}`,
    ...[...fields, 'template_delivery', 'audio_delivery'].map(key => `custom_data->${key}->>provider_message_id.eq.${provider}`)];
  if (fact.attemptId) filters.push(...fields.map(key => `custom_data->${key}->>id.eq.${JSON.stringify(fact.attemptId)}`));
  const { data, error } = await db().from('messages').select(select).eq('conversations.site_id', siteId).or(filters.join(',')).limit(2);
  if (error) throw unavailable();
  return data || [];
}

async function waitingForProviderId(b: InboundBinding, fact: EventFact) {
  // Receipt-only retry, never attribution by destination. An event without
  // an echo may have beaten the HTTP response that publishes the provider ID.
  const found = await Promise.all(fields.map(field => db().from('messages').select('id, conversations!inner(site_id)')
    .eq('conversations.site_id', b.siteId).eq('role', 'assistant').eq('custom_data->>status', 'reconciliation_required')
    .eq(`custom_data->${field}->>state`, 'attempting').eq(`custom_data->${field}->>sender_id`, b.senderId)
    .eq(`custom_data->${field}->>connection_id`, b.connectionId).eq(`custom_data->${field}->>channel`, b.channel)
    .eq(`custom_data->${field}->>recipient`, fact.recipient).is('custom_data->>provider_message_id', null)
    .is(`custom_data->${field}->>provider_message_id`, null).limit(1)));
  if (found.some(result => result.error)) throw unavailable();
  return found.some(result => result.data?.length);
}

function pinned(data: any) {
  // Historical/generic media claims do not identify a saved turn.
  const media = data?.native_media_delivery;
  return !!data?.pinned_text_delivery || (media && typeof media === 'object' &&
    ['inbound_message_id', 'origin_message_id', 'sender_id', 'zavu_from'].some(k => k in media));
}

async function verify(row: any, b: InboundBinding, fact: EventFact) {
  const meta = row.custom_data, conversation = row.conversations;
  const field = meta.pinned_text_delivery ? fields[0] : fields[1];
  const attempt = meta[field];
  if (row.role !== 'assistant' || typeof row.content !== 'string' || !present(row.id) || !present(row.conversation_id)
    || conversation?.site_id !== b.siteId || meta.connection_id !== b.connectionId || !isChannelReplyAttemptId(attempt?.id)
    || (fact.attemptId !== undefined && attempt.id !== fact.attemptId) || meta.automation_skipped
    || (meta.source != null && meta.source !== b.channel) || (meta.zavu_sender_id != null && meta.zavu_sender_id !== b.senderId)
    || (meta.zavu_from != null && meta.zavu_from !== attempt.zavu_from)
    || (meta.pinned_text_delivery && meta.native_media_delivery) || meta.audio_delivery || meta.template_delivery || meta.exact_delivery_receipt
    || (field === 'native_media_delivery' && !present(meta.media_url)) || meta.response_format === 'audio'
    || attempt.conflicting_provider_message_id != null) throw conflict();
  const storedIds = [meta.provider_message_id, attempt.provider_message_id].filter(id => id != null);
  if (!storedIds.length && fact.attemptId !== attempt.id) throw conflict();
  const disputed = storedIds.some(id => id !== fact.providerId);
  // Only a unique, exact echo on an otherwise coherent attempt can record two
  // conflicting facts. Never adopt an ID when the original observations disagree.
  if (disputed && (fact.attemptId !== attempt.id || storedIds.some(id => id !== storedIds[0]) || !present(storedIds[0]))) throw conflict();
  const active = attempt.state === 'attempting' && meta.status === 'reconciliation_required';
  const known = storedIds.length && (attempt.state === 'failed' ? meta.status === 'failed'
    : attempt.state === 'accepted' && isZavuAcceptedStatus(meta.status));
  if (!active && !known) throw conflict(); // Includes suppressed, disputed, and contradictory receipts.

  // Same read-only proof as the send path: verify the role=user inbound in this
  // site/conversation, the original full from, recipient, both message IDs,
  // origin, provider, connection, sender, channel and saved payload hash.
  const binding = await savedZavuReply({ conversationId: row.conversation_id, channel: conversation.channel,
    conversationData: conversation.custom_data, message: row }, {
    message_id: row.id, site_id: b.siteId, channel: b.channel, to: fact.recipient, message: row.content,
    response_format: meta.response_format, media_url: meta.media_url, message_type: meta.message_type, mime_type: meta.mime_type,
  });
  if (!binding || binding.connectionId !== b.connectionId || binding.senderId !== b.senderId) throw conflict();
  return { field, attempt, disputed };
}

/** Registered callback only, after the original signature and durable claim.
 * Returns true for an exact pinned receipt (including a monotone no-op). No
 * dispatch, provider lookup, generation or billing is performed by this path. */
export async function reconcilePinnedDeliveryEvent(event: any, verifiedSiteId?: string, verifiedConnectionId?: string): Promise<boolean> {
  const fact = parse(event);
  if (!fact) return false;
  const b = await resolveSender(fact, verifiedSiteId);
  if (verifiedSiteId !== undefined && (!present(verifiedConnectionId) || b?.connectionId !== verifiedConnectionId)) throw conflict();
  if (!b) {
    if (fact.attemptId) throw conflict();
    return false;
  }
  let pin: { rowId: string; attemptId: string } | undefined;
  for (let i = 0; i < 3; i++) {
    const rows = await candidates(b.siteId, fact);
    if (!rows.some(row => pinned(row.custom_data))) {
      if (pin || fact.attemptId) throw conflict();
      if (!rows.length && await waitingForProviderId(b, fact)) throw new Error('Pinned provider ID is not yet available; retry receipt processing');
      return false;
    }
    if (rows.length !== 1) throw conflict();
    const row = rows[0], meta = row.custom_data;
    const { field, attempt, disputed } = await verify(row, b, fact);
    if (pin && (row.id !== pin.rowId || attempt.id !== pin.attemptId)) throw conflict();
    pin = { rowId: row.id, attemptId: attempt.id };
    const current = await resolveSender(fact, b.siteId);
    if (current?.connectionId !== b.connectionId) throw conflict();
    const status = strongerZavuStatus(meta.status, fact.status);
    const state = status === 'failed' ? 'failed' : 'accepted';
    if (!disputed && meta.status === status && attempt.state === state && meta.provider_message_id === fact.providerId
      && attempt.provider_message_id === fact.providerId) return true;
    // No ID or delivery status replacement, even when the contrary observation
    // is signed. Recovery treats the immutable conflict marker as operator-only.
    const next = disputed ? { ...meta, [field]: { ...attempt, state: 'conflict', conflicting_provider_message_id: fact.providerId } }
      : { ...meta, status, source: b.channel, provider_message_id: fact.providerId,
      ...(state === 'accepted' && !meta.accepted_at ? { accepted_at: new Date().toISOString() } : {}),
      [field]: { ...attempt, state, provider_message_id: fact.providerId } };
    const { data, error } = await db().from('messages').update({ custom_data: next }).eq('id', row.id)
      .eq('role', 'assistant').eq('conversation_id', row.conversation_id).eq('content', row.content)
      .eq('custom_data', JSON.stringify(meta)).select('id').maybeSingle();
    if (error) throw unavailable();
    if (data && disputed) throw conflict();
    if (data) return true;
  }
  throw new Error('Pinned delivery receipt changed concurrently; retry receipt processing');
}
