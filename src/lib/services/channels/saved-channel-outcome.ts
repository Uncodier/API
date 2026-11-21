import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { isChannelReplyAttemptId, pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { isZavuAcceptedStatus } from '@/lib/messaging/zavu-receipt-state';
import { matchesZavuThread } from './zavu-thread-scope';
import { inboundZavuRecipient } from '../zavu/inbound-recipient';
import type { VerifiedChannelMessage } from './admit-message';
import type { ChannelOutcome } from './channel-message-reconciliation-error';

type Evidence = Omit<ChannelOutcome,'workflowId'>;
const unknown = (reason: string): Evidence => ({state:'unknown',stage:'delivery',reason});
const present = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v !== 'unknown';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Read-only after verified webhook admission. Locate by original site + connection
 * + inbound ID, never by contact, newest message or an ID supplied in the HTTP body. */
export async function readSavedChannelOutcome(input: VerifiedChannelMessage): Promise<Evidence | undefined> {
  const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
  const select = 'id, role, content, conversation_id, custom_data, conversations!inner(site_id,channel,custom_data)';
  const byTurn = (role: string) => db.from('messages').select(select).eq('conversations.site_id',input.siteId).eq('role',role)
    .eq('custom_data->>connection_id',input.connectionId).eq('custom_data->>origin_message_id',input.originMessageId).limit(2);
  const [{data:users,error:ue},{data:replies,error:re}] = await Promise.all([byTurn('user'),byTurn('assistant')]);
  if (ue || re) return unknown('receipt_store_unavailable');
  if (!users?.length && !replies?.length) return undefined;
  if (users?.length !== 1 || !replies || replies.length > 1) return unknown('ambiguous_saved_turn');
  const user = users[0], u = user.custom_data;
  const channelOK = (row: any) => {
    const thread = row.conversations;
    return thread?.site_id === input.siteId && matchesZavuThread(thread.channel, thread.custom_data, input.channel);
  };
  if (!present(user.id) || !present(user.conversation_id) || !channelOK(user) || u?.source !== 'zavu_inbound_message'
    || u.zavu_sender_id !== input.source.senderId || u.zavu_from !== input.source.from || u.channel !== input.channel) return unknown('inbound_scope_mismatch');
  if (!replies.length) {
    const reason = u.automation_suppressed === true && u.suppression_reason === 'channel_unavailable' ? 'channel_unavailable' : u.response_skipped === true
      ? (u.agent_disabled === true ? 'agent_disabled' : u.skip_reason === 'agent_snoozed' ? 'agent_snoozed' : undefined) : undefined;
    return reason ? {state:'suppressed',stage:'generation',reason,conversationId:user.conversation_id} : undefined;
  }
  const row = replies[0], data = row.custom_data;
  if (!present(row.id) || !channelOK(row) || typeof row.content !== 'string' || row.conversation_id !== user.conversation_id
    || String(data?.source ?? '').includes('comment') || data?.reply_to_message_id !== user.id || (data.channel != null && data.channel !== input.channel)) return unknown('reply_scope_mismatch');
  const ids = {messageId:row.id,conversationId:row.conversation_id,sendWorkflowId:`send-channel-reply-${row.id}`};
  const recipient = inboundZavuRecipient(input.source.from);
  const candidates = [data.pinned_text_delivery,data.native_media_delivery,data.audio_delivery,data.template_delivery].filter(Boolean);
  if (candidates.length > 1 || data.exact_delivery_receipt) return {...unknown('conflicting_delivery_receipts'),...ids};
  const r = candidates[0];
  const status = data.status, providerId = data.provider_message_id;
  const skip = data.automation_skipped === true && status === 'skipped' && !providerId
    && ['stale_automatic_reply','agent_snoozed'].includes(data.automation_skip_reason);
  if (!r) {
    if (data.sent_at || data.accepted_at || data.delivered_at || data.read_at) return {...ids,...unknown('historical_dispatch_marker')};
    if (!providerId && status === 'pending') return {...ids,state:'draft',stage:'delivery',reason:'approval_required'};
    if (skip) return {...ids,state:'suppressed',stage:'delivery',reason:data.automation_skip_reason};
    return {...ids,...unknown('no_bound_provider_receipt')};
  }
  if (r === data.pinned_text_delivery || r === data.native_media_delivery) {
    const scope = {provider:'zavu',site_id:input.siteId,channel:input.channel,connection_id:input.connectionId,sender_id:input.source.senderId,
      recipient,zavu_from:input.source.from,conversation_id:user.conversation_id,message_id:row.id,inbound_message_id:user.id,origin_message_id:input.originMessageId};
    if (!isChannelReplyAttemptId(r.id) || r.payload_hash !== pinnedReplyPayloadHash(row.content,data)
      || Object.entries(scope).some(([k,v])=>r[k] !== v) || Boolean(data.media_url) !== (r === data.native_media_delivery)) return {...ids,...unknown('attempt_scope_mismatch')};
    if (r.state === 'conflict' || r.conflicting_provider_message_id) return {...ids,...unknown('conflicting_provider_identity')};
    if (r.provider_message_id !== providerId && (r.provider_message_id || providerId)) return {...ids,...unknown('conflicting_provider_identity')};
    if (skip && r.state === 'skipped') return {...ids,state:'suppressed',stage:'delivery',reason:data.automation_skip_reason};
  } else if (r === data.audio_delivery) {
    const sender = JSON.stringify(['audio-sender-v1','zavu',input.source.senderId]);
    if (r.provider !== 'zavu' || r.site_id !== input.siteId || r.connection_id !== input.connectionId || r.sender_identity !== sender
      || r.channel !== input.channel || r.recipient !== recipient || r.key !== hash({text:row.content,channel:input.channel,to:recipient,sender})) return {...ids,...unknown('audio_scope_mismatch')};
  } else if (input.channel !== 'whatsapp' || r.connection_id !== input.connectionId || r.sender_id !== input.source.senderId
    || r.recipient !== recipient || r.key !== hash([row.content,recipient,input.source.senderId,input.connectionId])) return {...ids,...unknown('template_scope_mismatch')};
  if (status === 'failed' || r.state === 'failed' || r.state === 'rejected' || r.delivery_status === 'failed') return {...ids,state:'failed',stage:'delivery',reason:'provider_rejected'};
  if (!data.automation_skipped && present(providerId) && r.provider_message_id === providerId && isZavuAcceptedStatus(status)
    && ['accepted','queued','sending','sent','delivered','read'].includes(r.state)) return {...ids,state:'accepted',stage:'delivery',reason:'provider_accepted'};
  return {...ids,...unknown('dispatch_unconfirmed')};
}
