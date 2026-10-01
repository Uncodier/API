import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createHash } from 'crypto';
import { createOutreachLedger, type OutreachLedger } from './redis-ledger';
import { getOutreachPolicy, isOutreachChannel, localDay, nextLocalDay, outreachTimezone, resolveOutreachActivity, selectedOutreachAccounts, type OutreachActivityKey } from './policy';
import { outreachTimingReason } from './timing';
import { prepareOutreachDelivery, type DeliveryContext, type PreparedDelivery } from './transport';
import { summarizeOutreachHistory } from './history';
import { resolveOutreachRecipient } from './recipients';
import { loadOutreachConversations } from './recipient-repository';

export interface OutreachResult { success: boolean; deferred?: boolean; reason?: string; messageId?: string; alreadySent?: boolean; retryAt?: string; channel?: string; recipient?: string }
export interface Snapshot { message: any; conversation: any; lead: any; settings: any; conversations?: any[] }
export interface OutreachRepository {
  load(siteId: string, messageId: string): Promise<Snapshot | null>;
  history(siteId: string, leadId: string): Promise<any[]>;
  claim(message: any, marker: any): Promise<boolean>;
  mark(message: any, marker: any): Promise<void>;
  reservedCount(siteId: string, activity: OutreachActivityKey, day: string): Promise<number>;
  segmentBelongsToSite(siteId: string, segmentId: string): Promise<boolean>;
}

export const outreachRepository: OutreachRepository = {
  async segmentBelongsToSite(siteId, segmentId) {
    const { data, error } = await supabaseAdmin.from('segments').select('id').eq('id', segmentId).eq('site_id', siteId).maybeSingle();
    if (error) throw error;
    return !!data;
  },
  async load(siteId, messageId) {
    const { data: message, error } = await supabaseAdmin.from('messages').select('*').eq('id', messageId).maybeSingle();
    if (error) throw error;
    if (!message) return null;
    const { data: conversation, error: ce } = await supabaseAdmin.from('conversations').select('*')
      .eq('id', message.conversation_id).eq('site_id', siteId).maybeSingle();
    if (ce) throw ce;
    if (!conversation || !conversation.lead_id || (message.lead_id && message.lead_id !== conversation.lead_id)
      || (message.site_id && message.site_id !== siteId)) return null;
    const [{ data: lead, error: le }, { data: settings, error: se }] = await Promise.all([
      supabaseAdmin.from('leads').select('*').eq('id', conversation.lead_id).eq('site_id', siteId).maybeSingle(),
      supabaseAdmin.from('settings').select('channels,activities,business_hours').eq('site_id', siteId).maybeSingle(),
    ]);
    if (le || se) throw le || se;
    return lead ? { message, conversation, lead, settings,
      conversations: await loadOutreachConversations(siteId, lead.id) } : null;
  },
  async history(siteId, leadId) {
    const messages: any[] = [];
    // Explicit pagination avoids Supabase's implicit 1000-row truncation. Very
    // large histories fail closed instead of undercounting previous sends.
    for (let offset = 0; offset < 20000; offset += 1000) {
      const { data, error } = await supabaseAdmin.from('messages')
        .select('id,role,created_at,custom_data,conversations!inner(site_id,lead_id)')
        .eq('conversations.site_id', siteId).eq('conversations.lead_id', leadId)
        .order('id').range(offset, offset + 999);
      if (error) throw error;
      messages.push(...(data || []));
      if (!data || data.length < 1000) return messages;
    }
    throw new Error('Outreach history too large to safely evaluate');
  },
  async claim(message, marker) {
    let query = supabaseAdmin.from('messages').update({ custom_data: { ...(message.custom_data || {}), outreach_activity: marker.activity, outreach_delivery: marker } })
      .eq('id', message.id).eq('conversation_id', message.conversation_id);
    query = message.custom_data == null ? query.is('custom_data', null) : query.eq('custom_data', JSON.stringify(message.custom_data));
    const { data, error } = await query.select('id');
    if (error) throw error;
    return data?.length === 1;
  },
  async mark(message, marker) {
    // Do not overwrite workflow/provider metadata changed during dispatch.
    const { data: latest, error: readError } = await supabaseAdmin.from('messages').select('custom_data')
      .eq('id', message.id).eq('conversation_id', message.conversation_id).single();
    if (readError) throw readError;
    const { data, error } = await supabaseAdmin.from('messages')
      .update({ custom_data: { ...(latest.custom_data || {}), outreach_delivery: marker,
        ...(marker.state === 'sent' ? { ...(latest.custom_data?.voice_mode === 'agent_call' ? {} : { status: 'sent' }),
          provider_message_id: marker.provider_message_id, sent_at: marker.sent_at } : {}) } })
      .eq('id', message.id).eq('conversation_id', message.conversation_id)
      .eq('custom_data->outreach_delivery->>attempt_id', marker.attempt_id).select('id');
    if (error || !data?.length) throw error || new Error('Durable outreach ownership lost');
  },
  async reservedCount(siteId, activity, day) {
    const { count, error } = await supabaseAdmin.from('messages')
      .select('id,conversations!inner(site_id)', { count: 'exact', head: true })
      .eq('conversations.site_id', siteId)
      .eq('custom_data->outreach_delivery->>activity', activity)
      .eq('custom_data->outreach_delivery->>local_day', day);
    if (error || count == null) throw error || new Error('Cannot verify durable cap');
    return count;
  },
};

/** No transport is invoked until both atomic Redis and durable DB guards pass. */
export function createOutreachDelivery(deps: {
  repository?: OutreachRepository; ledger?: OutreachLedger;
  prepare?: (ctx: DeliveryContext) => Promise<PreparedDelivery>; now?: () => Date;
} = {}) {
  const repo = deps.repository || outreachRepository;
  const ledger = deps.ledger || createOutreachLedger();
  const prepare = deps.prepare || prepareOutreachDelivery;
  return async (siteId: string, messageId: string): Promise<OutreachResult> => {
    const now = deps.now?.() || new Date();
    const defer = (reason: string, retryAt = new Date(now.getTime() + 3600000).toISOString()): OutreachResult => ({ success: false, deferred: true, reason, retryAt });
    const uncertain = () => defer('delivery_uncertain', new Date(now.getTime() + 86400000).toISOString());
    try {
      const snapshot = await repo.load(siteId, messageId);
      if (!snapshot) return { success: false, reason: 'message_not_found' };
      const { message, conversation, lead, settings } = snapshot;
      const data = message.custom_data || {};
      const oldMarker = data.outreach_delivery;
      // Already-sent is checked before current eligibility: this only finalizes
      // a lost successful response and never starts a new provider delivery.
      if (oldMarker?.state === 'sent' || data.status === 'sent' || data.delivery?.success === true) {
        return { success: true, alreadySent: true, messageId: oldMarker?.provider_message_id || data.provider_message_id || data.provider_call_id || data.delivery?.details?.message_id,
          ...(oldMarker?.recipient ? { recipient: oldMarker.recipient, channel: oldMarker.channel } : {}) };
      }
      if (oldMarker?.state === 'dispatching') return uncertain();
      if (message.role !== 'assistant' || !['accepted', 'sending'].includes(data.status)) return defer('message_not_approved');
      const activity = resolveOutreachActivity(data);
      if (!activity) return defer('outreach_activity_required');
      const policy = getOutreachPolicy(settings, activity);
      if (!policy) return defer('invalid_outreach_configuration');
      if (policy.status !== 'active') return defer('activity_inactive');
      const timingReason = outreachTimingReason(settings, activity, now);
      if (timingReason) return defer(timingReason);
      if (!policy.all_segments && (!lead.segment_id || !policy.segment_ids.includes(lead.segment_id))) return defer('segment_not_selected');
      if (!policy.all_segments && !await repo.segmentBelongsToSite(siteId, lead.segment_id)) return defer('segment_not_selected');
      if (!['new', 'contacted', 'qualified'].includes(lead.status)) return defer('lead_ineligible');
      if (lead.metadata?.quarantined_cross_tenant || lead.assignee_id || lead.unsubscribed
        || lead.metadata?.unsubscribed === true || lead.metadata?.do_not_contact === true) return defer('lead_ineligible');
      const timezone = outreachTimezone(settings);
      let day: ReturnType<typeof localDay>;
      try { day = localDay(now, timezone); } catch { return defer('invalid_timezone'); }
      if (activity === 'leads_follow_up' && !policy.weekdays.includes(day.weekday)) return defer('outside_weekdays', nextLocalDay(now, timezone).toISOString());
      const channel = data.channel || conversation.channel;
      if (!isOutreachChannel(channel)) return defer('unsupported_channel');
      if (conversation.channel && conversation.channel !== channel) return defer('channel_mismatch');
      const accounts = selectedOutreachAccounts(settings, policy, channel);
      const history = await repo.history(siteId, lead.id);
      const sticky = history.filter(m => m.custom_data?.outreach_delivery?.state === 'sent'
        && accounts.some(a => a.id === m.custom_data.outreach_delivery.account_id))
        .sort((a, b) => Date.parse(b.custom_data.outreach_delivery.sent_at || b.created_at)
          - Date.parse(a.custom_data.outreach_delivery.sent_at || a.created_at))[0]?.custom_data.outreach_delivery.account_id;
      const index = createHash('sha256').update(lead.id).digest().readUInt32BE(0) % accounts.length;
      const account = accounts.find(a => a.id === sticky) || accounts[index];
      if (!account) return defer('no_selected_account');
      const recipient = resolveOutreachRecipient({ siteId, lead, channel, conversations: snapshot.conversations || [conversation] });
      if (!recipient) return defer(channel === 'voice' ? 'voice_recipient_ineligible' : 'invalid_recipient');
      const historyReason = (history: any[]) => {
        const h = summarizeOutreachHistory(history.filter(m => m.id !== message.id));
        if (h.uncertain) return 'delivery_uncertain';
        if ((activity === 'leads_initial_cold_outreach') === h.hasInbound) return 'audience_mismatch';
        if (h.unanswered >= policy.max_unanswered_messages) return 'unanswered_limit';
        return undefined;
      };
      const eligibility = historyReason(history);
      if (eligibility) return defer(eligibility);
      const prepared = await prepare({ siteId, message, conversation, lead, account, conversations: snapshot.conversations });
      if ('reason' in prepared) return defer(prepared.reason);
      // Preparation may cross midnight; never dispatch against yesterday's cap.
      const dispatchNow = deps.now?.() || new Date();
      if (localDay(dispatchNow, timezone).day !== day.day) return defer('local_day_changed', dispatchNow.toISOString());
      // Preparation can be slow and preferences may have changed since the first read.
      const current = await repo.load(siteId, messageId);
      if (!current) return defer('message_changed');
      const currentTimingReason = outreachTimingReason(current.settings, activity, dispatchNow);
      if (currentTimingReason) return defer(currentTimingReason);
      if (outreachTimezone(current.settings) !== timezone) return defer('timezone_changed');
      const baseline = await repo.reservedCount(siteId, activity, day.day);
      const reservation = await ledger.reserve({ siteId, activity, day: day.day, messageId, leadId: lead.id, limit: policy.daily_message_limit, baseline });
      if (reservation.state === 'sent') return { success: true, alreadySent: true, messageId: reservation.messageId };
      if (reservation.state === 'limited') return defer('daily_limit', nextLocalDay(now, timezone).toISOString());
      if (reservation.state === 'uncertain' || reservation.state === 'busy') return uncertain();
      if (reservation.state !== 'reserved') return defer('limiter_unavailable');
      const { lease } = reservation;
      const marker = { state: 'dispatching', attempt_id: lease.attemptId, activity, account_id: account.id, channel, recipient: recipient.recipient,
        local_day: day.day, timezone, started_at: now.toISOString() };
      // A DB write with an unknown result is itself treated conservatively.
      if (!await repo.claim(message, marker)) {
        await ledger.release(lease);
        return defer('message_changed');
      }
      // Monotonic durable reservation count is a second guard against Redis
      // restart/eviction. Blocked reservations deliberately consume capacity.
      const durableCount = await repo.reservedCount(siteId, activity, day.day);
      const postClaimReason = historyReason(await repo.history(siteId, lead.id));
      if (durableCount > policy.daily_message_limit || postClaimReason) {
        const reason = postClaimReason || 'daily_limit';
        await repo.mark(message, { ...marker, state: 'blocked', reason });
        await ledger.release(lease);
        return defer(reason, nextLocalDay(now, timezone).toISOString());
      }
      try {
        const actualDispatchTime = deps.now?.() || new Date();
        if (localDay(actualDispatchTime, timezone).day !== day.day) {
          await repo.mark(message, { ...marker, state: 'blocked', reason: 'local_day_changed' });
          await ledger.release(lease);
          return defer('local_day_changed', actualDispatchTime.toISOString());
        }
        const finalTimingReason = outreachTimingReason(current.settings, activity, actualDispatchTime);
        if (finalTimingReason) {
          await repo.mark(message, { ...marker, state: 'blocked', reason: finalTimingReason });
          await ledger.release(lease);
          return defer(finalTimingReason);
        }
        const sent = await prepared.send();
        if (!sent.success || !sent.messageId) return uncertain();
        const finalMarker = { ...marker, state: 'sent', provider_message_id: sent.messageId, sent_at: new Date().toISOString() };
        // Either durable success marker is sufficient to prevent retries. If DB
        // persistence fails, retain Redis sent/dispatching and report success.
        try { await repo.mark(message, finalMarker); } catch (error) { console.error('[Outreach] Could not persist sent marker', error); }
        try { await ledger.sent(lease, sent.messageId); } catch (error) { console.error('[Outreach] Could not finalize Redis lease', error); }
        return { success: true, messageId: sent.messageId, channel, recipient: recipient.recipient };
      } catch { return uncertain(); }
    } catch (error) {
      console.error('[Outreach] Delivery guard failed', error);
      return defer('delivery_guard_unavailable');
    }
  };
}