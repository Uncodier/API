import { supabaseAdmin } from '@/lib/database/supabase-client';

const states = new Set(['queued', 'sent', 'delivered', 'read', 'failed']);
const rank: Record<string, number> = { queued: 1, sending: 1, accepted: 1, sent: 2, failed: 3, delivered: 4, read: 5 };

/** Called only after signature verification and durable webhook admission. */
export async function reconcileTemplateDeliveryEvent(event: any): Promise<void> {
  const state = typeof event.type === 'string' ? event.type.replace(/^message\./, '') : '';
  const senderId = event.senderId || event.data?.senderId || event.sender?.id;
  const providerId = event.data?.messageId;
  if (!states.has(state) || event.data?.channel !== 'whatsapp' || typeof senderId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(senderId) || typeof providerId !== 'string' || !providerId || providerId.length > 200) return;
  // Resolve the signed provider sender to one site; never use client-provided site IDs.
  const { data: settings, error: settingsError } = await supabaseAdmin.from('settings').select('site_id')
    .contains('channels', { connections: [{ zavu_sender_id: senderId }] });
  if (settingsError) throw new Error('Template delivery sender lookup unavailable');
  if (!settings || settings.length !== 1) return;
  const siteId = settings[0].site_id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: rows, error } = await supabaseAdmin.from('messages').select('id, conversation_id, custom_data, conversations!inner(site_id)')
      .eq('conversations.site_id', siteId).eq('custom_data->template_delivery->>provider_message_id', providerId).limit(2);
    if (error) throw new Error('Template delivery receipt lookup unavailable');
    if (!rows?.length) {
      // A webhook can beat the HTTP send response. Do not acknowledge and lose
      // it or guess by recipient; let the provider retry after the ID is persisted.
      const { data: active, error: activeError } = await supabaseAdmin.from('messages').select('id, conversations!inner(site_id)')
        .eq('conversations.site_id', siteId).eq('custom_data->template_delivery->>sender_id', senderId)
        .eq('custom_data->template_delivery->>state', 'dispatching').limit(1);
      if (activeError || active?.length) throw new Error('Template dispatch receipt is not yet available');
      return; // Unrelated non-template messages retain their existing handling.
    }
    if (rows.length !== 1) throw new Error('Template provider receipt is ambiguous');
    const row = rows[0];
    const metadata = row.custom_data;
    const receipt = metadata?.template_delivery;
    if (!receipt || (receipt.sender_id || receipt.submitted_sender_id) !== senderId) return;
    if (receipt.recipient && event.data?.to && receipt.recipient !== event.data.to) return;
    const previous = metadata.status === 'failed' && !['delivered', 'read'].includes(receipt.delivery_status || receipt.state)
      ? 'failed' : receipt.delivery_status || receipt.state;
    // Delivery/read confirmation is stronger than a delayed failure. Failure
    // cannot be overwritten by queued/sent events arriving out of order.
    if ((rank[previous] || 0) >= rank[state]) return;
    const receiptState = state === 'queued' ? 'accepted' : state;
    const status = state === 'read' ? 'delivered' : state;
    const next = { ...metadata, status, needs_reconciliation: false, command_status: state === 'failed' ? 'failed'
      : ['sent', 'delivered', 'read'].includes(state) ? 'completed' : 'pending',
      error_message: state === 'failed' ? 'WhatsApp template delivery failed at the provider.' : null,
      template_delivery: { ...receipt, state: receiptState, delivery_status: state,
        provider_event_at: typeof event.timestamp === 'number' ? event.timestamp : null,
        ...(state === 'failed' ? { failure_code: String(event.data?.errorCode || 'PROVIDER_DELIVERY_FAILED').slice(0, 100) } : {}),
      },
    };
    const { data: updated, error: writeError } = await supabaseAdmin.from('messages').update({ custom_data: next })
      .eq('id', row.id).eq('conversation_id', row.conversation_id).eq('custom_data', JSON.stringify(metadata))
      .select('id').maybeSingle();
    if (writeError) throw new Error('Template delivery receipt update failed');
    if (updated) return;
  }
  throw new Error('Template receipt changed concurrently; retry delivery event');
}