/** Mirrored from Workflows outreachHistory: same cross-channel audience/counter. */
export function summarizeOutreachHistory(messages: any[]) {
  const inbound = messages.filter(message => {
    const d = message.custom_data || {};
    return message.role === 'user' && d.is_internal !== true && d.internal !== true
      && d.direction !== 'outbound' && !['system', 'notification'].includes(d.source);
  });
  const lastInboundAt = inbound.reduce((latest, m) => Math.max(latest, Date.parse(m.created_at) || 0), 0);
  const sent = new Set<string>();
  let uncertain = false;
  for (const m of messages) {
    const d = m.custom_data || {};
    if (d.outreach_delivery?.state === 'dispatching') uncertain = true;
    // A collection touch is not an unanswered sales-prospecting touch.
    if (d.outreach_activity === 'invoices_due' || d.outreach_delivery?.activity === 'invoices_due') continue;
    if (m.role !== 'assistant' || !(d.status === 'sent' || d.delivery?.success === true || d.outreach_delivery?.state === 'sent')) continue;
    const at = Date.parse(d.outreach_delivery?.sent_at || d.delivery?.timestamp || d.timestamp_sync?.delivery_timestamp || m.created_at);
    if (!Number.isFinite(at) || at <= lastInboundAt) continue;
    sent.add(d.outreach_delivery?.provider_message_id || d.delivery?.details?.message_id || d.external_message_id || d.message_id || m.id);
  }
  return { hasInbound: lastInboundAt > 0, unanswered: sent.size, uncertain };
}