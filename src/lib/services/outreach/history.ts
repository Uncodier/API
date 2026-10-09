/** Mirrored from Workflows outreachHistory: same cross-channel audience/counter. */
export function outreachCooldownMs(unanswered: number, mode: 'progressive' | 'fixed', fixedDays?: number): number {
  if (unanswered < 1) return 0;
  return (mode === 'fixed' ? fixedDays! : [1, 1, 3, 7, 14][Math.min(unanswered - 1, 4)]) * 86400000;
}

export function nextOutreachContactAt(history: ReturnType<typeof summarizeOutreachHistory>, mode: 'progressive' | 'fixed', fixedDays?: number): number {
  return history.unanswered && history.lastSentAt ? history.lastSentAt + outreachCooldownMs(history.unanswered, mode, fixedDays) : 0;
}

export function summarizeOutreachHistory(messages: any[]) {
  const inbound = messages.filter(message => {
    const d = message.custom_data || {};
    return message.role === 'user' && d.is_internal !== true && d.internal !== true
      && d.direction !== 'outbound' && !['system', 'notification'].includes(d.source);
  });
  const lastInboundAt = inbound.reduce((latest, m) => Math.max(latest, Date.parse(m.created_at) || 0), 0);
  const sent = new Set<string>();
  let uncertain = false;
  let lastSentAt = 0;
  for (const m of messages) {
    const d = m.custom_data || {};
    if (d.outreach_delivery?.state === 'dispatching') uncertain = true;
    // A collection touch is not an unanswered sales-prospecting touch.
    if (d.outreach_activity === 'invoices_due' || d.outreach_delivery?.activity === 'invoices_due') continue;
    if (m.role !== 'assistant' || !(d.status === 'sent' || d.delivery?.success === true || d.outreach_delivery?.state === 'sent')) continue;
    const at = Date.parse(d.outreach_delivery?.sent_at || d.delivery?.timestamp || d.timestamp_sync?.delivery_timestamp || m.created_at);
    if (!Number.isFinite(at)) continue;
    lastSentAt = Math.max(lastSentAt, at);
    if (at <= lastInboundAt) continue;
    sent.add(d.outreach_delivery?.provider_message_id || d.delivery?.details?.message_id || d.external_message_id || d.message_id || m.id);
  }
  return { hasInbound: lastInboundAt > 0, lastSentAt, unanswered: sent.size, uncertain };
}