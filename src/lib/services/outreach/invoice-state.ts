import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getOutreachPolicy, localDay, outreachTimezone } from './policy';
import { outreachTimingReason } from './timing';

/** Sent receipts for this invoice only; the first reminder has no cooldown. */
export function invoiceCooldownDays(sentCount: number, mode: 'progressive' | 'fixed', fixedDays: number): number {
  return sentCount < 1 ? 0 : mode === 'fixed' ? fixedDays : [1, 1, 3, 7, 14][Math.min(sentCount - 1, 4)];
}

export function invoiceContactReason(lead: any): string | undefined {
  if (!lead || lead.metadata?.quarantined_cross_tenant || lead.unsubscribed
    || lead.metadata?.unsubscribed === true || lead.metadata?.do_not_contact === true) return 'recipient_ineligible';
}

/** A converted or assigned buyer is not a prospect. No status/segment filters. */
export function invoiceDueReason(siteId: string, sale: any, lead: any, settings: any, now = new Date(), site: any = { id: siteId }): string | undefined {
  if (!sale || sale.site_id !== siteId) return 'sale_not_found';
  if (!site || site.id !== siteId || site.archived_at) return 'site_inactive';
  const policy = getOutreachPolicy(settings, 'invoices_due');
  if (!policy) return 'invalid_outreach_configuration';
  if (policy.status !== 'active') return 'activity_inactive';
  try {
    const day = localDay(now, outreachTimezone(settings));
    if (sale.status !== 'pending' || !Number.isFinite(Number(sale.amount_due)) || Number(sale.amount_due) <= 0
      || typeof sale.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sale.due_date)
      || sale.due_date < '0001-01-01'
      || !Number.isFinite(Date.parse(sale.due_date)) || new Date(sale.due_date).toISOString().slice(0, 10) !== sale.due_date
      || sale.due_date > day.day) return 'invoice_not_due';
    if (!sale.lead_id || !lead || lead.site_id !== siteId || lead.id !== sale.lead_id) return 'unsupported_recipient';
    const contact = invoiceContactReason(lead);
    if (contact) return contact;
    if (!policy.weekdays.includes(day.weekday)) return 'outside_weekdays';
    return outreachTimingReason(settings, 'invoices_due', now);
  } catch { return 'invalid_timezone'; }
}

export async function loadInvoiceState(siteId: string, saleId: string, reminderId?: string) {
  const { data: sale, error } = await supabaseAdmin.from('sales').select('*').eq('id', saleId).eq('site_id', siteId).maybeSingle();
  if (error) throw error;
  let reminder: any = null;
  if (reminderId) {
    const result = await supabaseAdmin.from('invoice_reminders').select('*').eq('id', reminderId)
      .eq('site_id', siteId).eq('sale_id', saleId).maybeSingle();
    if (result.error) throw result.error;
    reminder = result.data;
  }
  const siteResult = await supabaseAdmin.from('sites').select('id,archived_at').eq('id', siteId).maybeSingle();
  if (siteResult.error) throw siteResult.error;
  let lastSentAt: string | null = null;
  let sentCount = 0;
  if (reminderId) {
    const previous = await supabaseAdmin.from('invoice_reminders').select('sent_at', { count: 'exact' }).eq('site_id', siteId).eq('sale_id', saleId)
      .eq('state', 'sent').order('sent_at', { ascending: false }).limit(1).maybeSingle();
    if (previous.error) throw previous.error;
    lastSentAt = previous.data?.sent_at || null;
    if (previous.count === null || previous.count === undefined) throw new Error('Invoice reminder count unavailable');
    sentCount = previous.count;
  }
  return { sale, reminder, site: siteResult.data, lastSentAt, sentCount };
}

/** Explicit provenance alone is not authority to use collection exemptions. */
export function invoiceMessageReason(siteId: string, snapshot: any, now: Date): string | undefined {
  const { sale, reminder, lead, settings, message, site } = snapshot;
  const reason = invoiceDueReason(siteId, sale, lead, settings, now, site);
  if (reason) return reason;
  const d = message.custom_data || {};
  if (!reminder || reminder.site_id !== siteId || reminder.sale_id !== sale.id || reminder.id !== d.invoice_reminder_id
    || reminder.reminder_key !== d.invoice_reminder_key || reminder.message_id !== message.id
    || reminder.state !== 'ready' || d.sale_id !== sale.id) return 'invoice_reminder_not_authorized';
  if (reminder.sent_at || reminder.provider_message_id
    || (Object.prototype.hasOwnProperty.call(d, 'outreach_delivery') && d.outreach_delivery?.state !== 'blocked')
    || ['sent_at', 'provider_message_id', 'provider_call_id', 'external_message_id'].some(key => Object.prototype.hasOwnProperty.call(d, key))
    || d.delivery?.success === true) return 'delivery_uncertain';
  const policy = getOutreachPolicy(settings, 'invoices_due')!;
  if (snapshot.sentCount > 0 && (!snapshot.lastSentAt || !Number.isFinite(Date.parse(snapshot.lastSentAt))
    || now.getTime() - Date.parse(snapshot.lastSentAt) < invoiceCooldownDays(snapshot.sentCount, policy.cooldown_mode, policy.repeat_interval_days) * 86400000)) return 'repeat_interval';
  // Historical snapshots without a count still enforce the last confirmed send conservatively.
  if (snapshot.sentCount === undefined && snapshot.lastSentAt && (!Number.isFinite(Date.parse(snapshot.lastSentAt))
    || now.getTime() - Date.parse(snapshot.lastSentAt) < policy.repeat_interval_days * 86400000)) return 'repeat_interval';
  // Content generated for a previous financial balance/date must not be sent.
  if (d.invoice_due_date !== sale.due_date || Number(d.invoice_amount_due) !== Number(sale.amount_due)
    || d.invoice_currency !== sale.currency) return 'invoice_changed';
}

export async function markInvoiceSent(siteId: string, message: any, providerId: string, sentAt: string) {
  const d = message.custom_data;
  if (d?.outreach_activity !== 'invoices_due') return;
  if (!providerId || !Number.isFinite(Date.parse(sentAt))) throw new Error('Invoice send confirmation incomplete');
  const { data, error } = await supabaseAdmin.from('invoice_reminders').update({ state: 'sent', sent_at: sentAt, provider_message_id: providerId })
    .eq('id', d.invoice_reminder_id).eq('site_id', siteId).eq('sale_id', d.sale_id).eq('message_id', message.id).select('id');
  if (error || !data?.length) throw error || new Error('Invoice receipt ownership lost');
}

export async function cancelStaleInvoiceReminder(siteId: string, saleId: string) {
  const { error } = await supabaseAdmin.rpc('cancel_stale_invoice_reminder', { p_site_id: siteId, p_sale_id: saleId });
  if (error) throw error;
}