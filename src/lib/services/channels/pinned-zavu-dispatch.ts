import { randomUUID } from 'node:crypto';
import { AutomationSendSuppressed } from './automation-send-guard';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isChannelReplyAttemptId, pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { isAcceptedZavuMessage } from '@/lib/messaging/exact-zavu-response';
import { isZavuAcceptedStatus, strongerZavuStatus, type ZavuReceiptStatus } from '@/lib/messaging/zavu-receipt-state';
import { zavuAttemptScope, type SavedZavuBinding } from './saved-zavu-reply';

const reconcile = () => Object.assign(new Error('Original channel reply requires receipt reconciliation'), { status: 409 });
const unavailable = () => Object.assign(new Error('Saved channel reply receipt is unavailable'), { status: 503 });
type Data = Record<string, any>;
const db = () => supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
type ClaimOptions = { field: 'pinned_text_delivery' } | {
  field: 'native_media_delivery'; mediaUrl: string; messageType: string; mimeType?: string;
};

function assertBinding(b: SavedZavuBinding, data: Data, options: ClaimOptions) {
  if (data.connection_id !== b.connectionId || data.origin_message_id !== b.eventId || data.reply_to_message_id !== b.inboundMessageId
    || (data.channel !== undefined && data.channel !== b.channel) || data.response_format === 'audio') throw reconcile();
  if (options.field === 'native_media_delivery' ? (data.media_url !== options.mediaUrl
    || data.message_type !== options.messageType || data.mime_type !== options.mimeType || data.pinned_text_delivery)
    : (data.media_url || data.native_media_delivery)) throw reconcile();
  const attempt = data[options.field];
  if (attempt && Object.entries(zavuAttemptScope(b)).some(([key, value]) => attempt[key] !== value)) throw reconcile();
}

async function load(b: SavedZavuBinding, content: string, expected?: Data): Promise<Data> {
  let query = db().from('messages').select('custom_data, conversations!inner(site_id)')
    .eq('id', b.messageId).eq('conversation_id', b.conversationId).eq('role', 'assistant').eq('content', content)
    .eq('conversations.site_id', b.siteId);
  if (expected) query = query.eq('custom_data', JSON.stringify(expected));
  const { data: row, error } = await query.maybeSingle();
  if (error) throw unavailable();
  if (!row?.custom_data) throw reconcile();
  return row.custom_data;
}

async function write(b: SavedZavuBinding, content: string, previous: Data, next: Data) {
  const { data, error } = await db().from('messages').update({ custom_data: next }).eq('id', b.messageId)
    .eq('conversation_id', b.conversationId).eq('role', 'assistant').eq('content', content)
    .eq('custom_data', JSON.stringify(previous)).select('id').maybeSingle();
  if (error) throw unavailable();
  return Boolean(data);
}

const response = (id: string, status: ZavuReceiptStatus) => {
  if (!isZavuAcceptedStatus(status)) throw reconcile();
  return { success: true, accepted: true, provider: 'zavu' as const, receiptHandled: true, messageId: id, providerStatus: status,
    delivered: status === 'delivered' || status === 'read' };
};

/** The claim precedes even optional paid TTS. A crash at any later instruction
 * is read-only on replay: neither generation, charging nor dispatch is repeated. */
export async function dispatchPinnedZavu(binding: SavedZavuBinding, content: string, original: Data,
  send: (attemptId: string) => Promise<unknown>, options: ClaimOptions = { field: 'pinned_text_delivery' }) {
  const key = options.field;
  original = await load(binding, content, original);
  assertBinding(binding, original, options);
  const hash = pinnedReplyPayloadHash(content, original);
  const prior = original[key];
  if (original.provider_message_id || prior || original.status === 'reconciliation_required') {
    if ((isChannelReplyAttemptId(prior?.id) && prior.state === 'accepted' && prior.payload_hash === hash
        && prior.provider_message_id === original.provider_message_id)
      && typeof original.provider_message_id === 'string' && original.provider_message_id.trim() && original.provider_message_id !== 'unknown'
      && isZavuAcceptedStatus(original.status)) return response(original.provider_message_id, original.status);
    throw reconcile();
  }
  // A historical dispatch marker without a provider ID is not permission to send.
  if ((original.status != null && !['approved', 'ready'].includes(original.status)) || original.automation_skipped
    || original.sent_at || original.accepted_at || original.delivered_at || original.read_at
    || original.exact_delivery_receipt || original.template_delivery || original.audio_delivery) throw reconcile();
  const attempt = { ...zavuAttemptScope(binding), id: randomUUID(), payload_hash: hash, state: 'attempting', at: new Date().toISOString() };
  if (!await write(binding, content, original, { ...original, status: 'reconciliation_required', [key]: attempt })) throw reconcile();
  const fromRecordedEvent = async () => {
    const data = await load(binding, content);
    const receipt = data[key];
    assertBinding(binding, data, options);
    if (receipt?.id !== attempt.id || receipt.state !== 'accepted' || receipt.payload_hash !== hash
      || data.automation_skipped || receipt.provider_message_id !== data.provider_message_id
      || typeof data.provider_message_id !== 'string' || !data.provider_message_id.trim() || data.provider_message_id === 'unknown'
      || !isZavuAcceptedStatus(data.status)) throw reconcile();
    return response(data.provider_message_id, data.status);
  };
  let result: unknown;
  try { result = await send(attempt.id); } catch (error) {
    // Preserve a verified pre-dispatch suppression/conflict. For a transport
    // error, an exact signed event may already have independently resolved it.
    if (error instanceof AutomationSendSuppressed || (error as {status?:number} | null)?.status === 409) throw error;
    return await fromRecordedEvent();
  }
  const msg = (result as {message?: {id?: unknown; status?: unknown}} | null)?.message;
  const accepted = isAcceptedZavuMessage(result);
  const rejected = msg?.status === 'failed';
  if ((!accepted && !rejected) || !msg || typeof msg.id !== 'string' || !msg.id.trim() || msg.id === 'unknown') return await fromRecordedEvent();
  const status: ZavuReceiptStatus = isAcceptedZavuMessage(result) ? result.message.status : 'failed';
  // A signed event may have already recorded a stronger status while the POST
  // was in flight. Re-read and compare-and-set, without repeating the POST.
  for (let i = 0; i < 3; i++) {
    const data = await load(binding, content);
    assertBinding(binding, data, options);
    if (data[key]?.id === attempt.id && data[key].payload_hash === hash && (
      (data.provider_message_id && data.provider_message_id !== msg.id)
        || (data[key].provider_message_id && data[key].provider_message_id !== msg.id))) {
      // Preserve both observations. A later replay must not adopt either ID
      // as authoritative or downgrade an earlier read receipt.
      if (data[key].state !== 'conflict' && !await write(binding, content, data, { ...data,
        [key]: { ...data[key], state: 'conflict', conflicting_provider_message_id: msg.id },
      })) continue;
      throw reconcile();
    }
    if (!data || data[key]?.id !== attempt.id || data[key].payload_hash !== hash
      || !['attempting', 'accepted', 'failed'].includes(data[key].state)
      || data.automation_skipped || ['pending', 'skipped', 'cancelled', 'declined', 'rejected'].includes(data.status)) throw reconcile();
    if (data.status !== 'reconciliation_required' && !data.provider_message_id) throw reconcile();
    const merged = strongerZavuStatus(data.status, status);
    const next = { ...data, source: binding.channel, status: merged, provider_message_id: msg.id,
      ...(merged === 'failed' ? {} : { accepted_at: data.accepted_at || new Date().toISOString() }),
      [key]: { ...data[key], state: merged === 'failed' ? 'failed' : 'accepted', provider_message_id: msg.id } };
    if (await write(binding, content, data, next)) return response(msg.id, merged);
  }
  throw reconcile();
}
