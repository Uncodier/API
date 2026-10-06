import { supabaseAdmin } from '@/lib/database/supabase-client';
import { findActiveSalesAgent } from '@/lib/services/lead-followup/helpers/LeadFollowUpAgentHelper';
import { createOutreachDelivery, outreachRepository, type OutreachResult } from './delivery';
import { generateInvoiceReminder } from './invoice-generation';
import { cancelStaleInvoiceReminder, invoiceDueReason, loadInvoiceState } from './invoice-state';
import { getOutreachPolicy, localDay, outreachTimezone, selectedOutreachChannels } from './policy';
import { availableOutreachRecipients, isNonDirectIdentity } from './recipients';
import { loadOutreachConversations } from './recipient-repository';

export interface InvoiceReminderResult { success: boolean; skipped?: boolean; reason?: string; message_id?: string; command_id?: string }
export const invoiceRepository = {
  async load(siteId: string, saleId: string) {
    const { sale, site } = await loadInvoiceState(siteId, saleId);
    const [{ data: settings, error: se }, leadResult] = await Promise.all([
      supabaseAdmin.from('settings').select('channels,activities,business_hours').eq('site_id', siteId).maybeSingle(),
      sale?.lead_id ? supabaseAdmin.from('leads').select('*').eq('id', sale.lead_id).eq('site_id', siteId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    if (se || leadResult.error) throw se || leadResult.error;
    const lead = leadResult.data;
    return { sale, site, settings, lead, conversations: lead ? await loadOutreachConversations(siteId, lead.id) : [] };
  },
  agent: findActiveSalesAgent,
  cancel: cancelStaleInvoiceReminder,
  reservedCount: outreachRepository.reservedCount,
  async claim(siteId: string, saleId: string, key: string, day: string, interval: number): Promise<any> {
    const { data, error } = await supabaseAdmin.rpc('claim_invoice_reminder', { p_site_id: siteId, p_sale_id: saleId,
      p_reminder_key: key, p_local_day: day, p_interval_days: interval });
    if (error || !data) throw error || new Error('Invoice claim unavailable');
    return data;
  },
  async queue(siteId: string, snapshot: any, reminder: any, agent: any, content: any): Promise<string> {
    const { lead, sale, conversations } = snapshot;
    let conversationId = conversations.find((c: any) => c.channel === content.channel && !isNonDirectIdentity(c.custom_data))?.id;
    if (!conversationId) {
      const { data, error } = await supabaseAdmin.from('conversations').insert({ site_id: siteId, lead_id: lead.id,
        user_id: agent.userId, agent_id: agent.agentId, channel: content.channel, title: content.title, status: 'pending',
        custom_data: { outreach_activity: 'invoices_due', sale_id: sale.id } }).select('id').single();
      if (error || !data) throw error || new Error('Invoice conversation unavailable');
      conversationId = data.id;
    }
    const { data: message, error } = await supabaseAdmin.from('messages').insert({ conversation_id: conversationId,
      lead_id: lead.id, user_id: agent.userId, agent_id: agent.agentId, role: 'assistant', content: content.message,
      custom_data: { status: 'accepted', channel: content.channel, title: content.title, outreach_activity: 'invoices_due',
        sale_id: sale.id, invoice_reminder_id: reminder.id, invoice_reminder_key: reminder.reminder_key,
        invoice_due_date: sale.due_date, invoice_amount_due: sale.amount_due, invoice_currency: sale.currency } }).select('id').single();
    if (error || !message) throw error || new Error('Invoice message unavailable');
    const result = await supabaseAdmin.from('invoice_reminders').update({ state: 'ready', message_id: message.id, command_id: content.command_id })
      .eq('id', reminder.id).eq('site_id', siteId).eq('sale_id', sale.id).eq('state', 'generating').select('id');
    if (result.error || result.data?.length !== 1) throw result.error || new Error('Invoice receipt ownership lost');
    return message.id;
  },
};

/** One persistent claim owns generation. Ready retries reuse the original message. */
export function createInvoiceReminders(deps: { repository?: typeof invoiceRepository; generate?: typeof generateInvoiceReminder;
  deliver?: (siteId: string, messageId: string) => Promise<OutreachResult>; now?: () => Date } = {}) {
  const repo = deps.repository || invoiceRepository;
  const generate = deps.generate || generateInvoiceReminder;
  const deliver = deps.deliver || createOutreachDelivery();
  return async (siteId: string, saleId: string, reminderKey: string): Promise<InvoiceReminderResult> => {
    const skip = (reason: string): InvoiceReminderResult => ({ success: true, skipped: true, reason });
    try {
      const snapshot = await repo.load(siteId, saleId);
      const now = deps.now?.() || new Date();
      const reason = invoiceDueReason(siteId, snapshot.sale, snapshot.lead, snapshot.settings, now, snapshot.site);
      if (reason) {
        if (reason === 'invoice_not_due') await repo.cancel(siteId, saleId);
        return skip(reason);
      }
      const policy = getOutreachPolicy(snapshot.settings, 'invoices_due')!;
      const recipients = availableOutreachRecipients({ siteId, lead: snapshot.lead, conversations: snapshot.conversations,
        channels: selectedOutreachChannels(snapshot.settings, policy) });
      const channels = Object.keys(recipients);
      if (!channels.length) return skip('no_selected_recipient');
      const agent = await repo.agent(siteId);
      if (!agent) return skip('no_active_agent');
      const day = localDay(now, outreachTimezone(snapshot.settings)).day;
      // Avoid generating thousands of drafts once today's durable budget is
      // exhausted. Delivery still owns the authoritative atomic reservation.
      if (await repo.reservedCount(siteId, 'invoices_due', day) >= policy.daily_message_limit) return skip('daily_limit');
      const claim = await repo.claim(siteId, saleId, reminderKey, day, policy.repeat_interval_days);
      if (!claim.claimed && claim.reason !== 'ready') return skip(claim.reason || 'reminder_uncertain');
      const reminder = claim.reminder;
      let messageId = reminder.message_id;
      let commandId = reminder.command_id;
      if (claim.claimed) {
        const content = await generate({ siteId, sale: snapshot.sale, lead: snapshot.lead, channels, agent });
        // The delivery service rechecks the sale and policy again immediately
        // before transport; generation never qualifies or mutates the buyer.
        messageId = await repo.queue(siteId, snapshot, reminder, agent, content);
        commandId = content.command_id;
      }
      if (!messageId) return skip('reminder_uncertain');
      const result = await deliver(siteId, messageId);
      if (result.reason === 'invoice_changed' || result.reason === 'invoice_not_due') await repo.cancel(siteId, saleId);
      const unavailable = ['delivery_guard_unavailable', 'limiter_unavailable'].includes(result.reason || '');
      return { success: result.success, ...(result.deferred && !unavailable ? { skipped: true } : {}), ...(result.reason ? { reason: result.reason } : {}),
        message_id: messageId, ...(commandId ? { command_id: commandId } : {}) };
    } catch (error) {
      console.error('[InvoiceReminders] Guard or generation unavailable', error);
      // Do not create a second generation after an unknown command/write/send.
      return { success: false, reason: 'invoice_reminder_unavailable' };
    }
  };
}