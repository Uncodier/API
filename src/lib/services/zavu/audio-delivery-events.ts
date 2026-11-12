import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { audioSenderIdentity } from '../channels/audio-sender-identity';

const rank: Record<string, number> = { queued: 1, dispatching: 0, unknown: 0, sent: 2, failed: 3, delivered: 4, read: 5 };
const channels = new Set(['whatsapp', 'telegram', 'messenger']);

/** Signed events only; the configured sender determines the site, never payload site IDs. */
export async function reconcileAudioDeliveryEvent(event: any): Promise<void> {
  const state = typeof event.type === 'string' ? event.type.replace(/^message\./, '') : '';
  const senderId = event.senderId || event.data?.senderId || event.sender?.id;
  const providerId = event.data?.messageId;
  const channel = event.data?.channel;
  const recipient = event.data?.to;
  if (!['queued', 'sent', 'failed', 'delivered', 'read'].includes(state) || !channels.has(channel)
    || typeof senderId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(senderId)
    || typeof providerId !== 'string' || !providerId || providerId.length > 200
    || typeof recipient !== 'string' || !recipient || recipient.length > 500) return;
  const { data: settings, error: settingsError } = await supabaseAdmin.from('settings').select('site_id, channels')
    .contains('channels', { connections: [{ zavu_sender_id: senderId }] });
  if (settingsError) throw new Error('Audio delivery sender lookup unavailable');
  if (settings?.length !== 1) return;
  const siteId = settings[0].site_id;
  const connections = settings[0].channels?.connections;
  if (!Array.isArray(connections)) return;
  const senderConnections = connections.filter((c: any) => c.zavu_sender_id === senderId && c.type === channel);
  if (!senderConnections.length) return;

  const bound = (row: any) => {
    const receipt = row.custom_data?.audio_delivery;
    const conversation = row.conversations;
    if (!receipt || !['assistant', 'team_member'].includes(row.role) || conversation?.site_id !== siteId
      || (conversation.channel || conversation.custom_data?.channel || conversation.custom_data?.source) !== channel) return false;
    if (receipt.site_id && receipt.site_id !== siteId) return false;
    if (receipt.channel && receipt.channel !== channel) return false;
    if (receipt.recipient && receipt.recipient !== recipient) return false;
    if (receipt.provider && receipt.provider !== 'zavu') return false;
    if (receipt.sender_identity && receipt.sender_identity !== audioSenderIdentity({ provider: 'zavu', senderId })) return false;
    if (receipt.sender_id) return receipt.sender_id === senderId && receipt.recipient === recipient && receipt.channel === channel;
    // Old receipts contain only a hash. A saved exact connection AND the hash
    // must verify sender/channel/recipient/text; never infer by recipient alone.
    const connectionId = receipt.connection_id || row.custom_data?.connection_id || conversation.custom_data?.connection_id;
    const matches = connections.filter((c: any) => c.id === connectionId);
    if (!connectionId || matches.length !== 1 || matches[0].zavu_sender_id !== senderId || matches[0].type !== channel
      || typeof row.content !== 'string') return false;
    const sender = receipt.sender_identity || audioSenderIdentity({ provider: 'zavu', senderId });
    if (sender !== audioSenderIdentity({ provider: 'zavu', senderId })) return false;
    const key = createHash('sha256').update(JSON.stringify({ text: row.content, channel, to: recipient, sender })).digest('hex');
    return receipt.key === key;
  };
  const selection = 'id, content, role, conversation_id, custom_data, conversations!inner(site_id, channel, custom_data)';
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: rows, error } = await supabaseAdmin.from('messages').select(selection)
      .eq('conversations.site_id', siteId).eq('custom_data->audio_delivery->>provider_message_id', providerId).limit(2);
    if (error) throw new Error('Audio delivery receipt lookup unavailable');
    if (!rows?.length) {
      const { data: active, error: activeError } = await supabaseAdmin.from('messages').select(selection)
        .eq('conversations.site_id', siteId).eq('custom_data->audio_delivery->>state', 'dispatching').limit(100);
      if (activeError || active?.length === 100 || active?.some(bound)) {
        throw new Error('Audio dispatch receipt is not yet available');
      }
      return;
    }
    if (rows.length !== 1) throw new Error('Audio provider receipt is ambiguous');
    const row = rows[0];
    if (!bound(row)) return;
    const metadata = row.custom_data;
    const receipt = metadata.audio_delivery;
    const previous = metadata.status === 'failed' && !['delivered', 'read'].includes(receipt.delivery_status || receipt.state)
      ? 'failed' : receipt.delivery_status || receipt.state;
    if ((rank[previous] || 0) >= rank[state]) return;
    const next = { ...metadata, status: state === 'read' ? 'delivered' : state, needs_reconciliation: false,
      command_status: state === 'failed' ? 'failed' : state === 'queued' ? 'pending' : 'completed',
      error_message: state === 'failed' ? 'Audio delivery failed at the provider.' : null,
      provider_message_id: providerId,
      audio_delivery: { ...receipt, state, delivery_status: state,
        provider_event_at: typeof event.timestamp === 'number' ? event.timestamp : null,
        failure_code: state === 'failed' ? String(event.data?.errorCode || 'PROVIDER_DELIVERY_FAILED').slice(0, 100) : null },
    };
    const { data: updated, error: writeError } = await supabaseAdmin.from('messages').update({ custom_data: next })
      .eq('id', row.id).eq('conversation_id', row.conversation_id).eq('custom_data', JSON.stringify(metadata))
      .select('id').maybeSingle();
    if (writeError) throw new Error('Audio delivery receipt update failed');
    if (updated) return;
  }
  throw new Error('Audio receipt changed concurrently; retry delivery event');
}