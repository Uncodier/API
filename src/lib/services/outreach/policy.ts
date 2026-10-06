import { validOutreachTiming } from './timing';

export type OutreachActivityKey = 'leads_initial_cold_outreach' | 'leads_follow_up' | 'invoices_due';
export type OutreachChannel = string;
/** Channel names become record keys. Audio is a message format, not an account. */
export function isOutreachChannel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
    && !Object.prototype.hasOwnProperty.call(Object.prototype, value) && value !== 'prototype' && value !== 'audio';
}
export interface OutreachAccount {
  id: string;
  channel: OutreachChannel;
  provider: 'zavu' | 'email' | 'agent_email' | 'whatsapp' | 'agent_whatsapp';
  config: Record<string, any>;
}
export interface OutreachPolicy {
  status: string;
  channel_accounts: Record<OutreachChannel, string[]>;
  segment_ids: string[];
  all_segments: boolean;
  daily_message_limit: number;
  max_unanswered_messages: number;
  weekdays: number[];
  repeat_interval_days: number;
}

export function isOutreachActivity(value: unknown): value is OutreachActivityKey {
  return value === 'leads_initial_cold_outreach' || value === 'leads_follow_up' || value === 'invoices_due';
}

/** Kept in sync with Workflows/utils/outreachActivity.ts for historical queued work. */
export function resolveOutreachActivity(data: Record<string, any> | null | undefined): OutreachActivityKey | undefined {
  if (!data) return undefined;
  if (isOutreachActivity(data.outreach_activity)) return data.outreach_activity;
  // An explicitly invalid marker must not silently select a different policy.
  if (data.outreach_activity !== undefined) return undefined;
  if (data.triggeredBy === 'dailyProspectionWorkflow') return 'leads_initial_cold_outreach';
  if (data.triggeredBy === 'leadQualificationWorkflow' || data.sequence_stage
    || data.follow_up_type === 'lead_nurture' || data.follow_up_type === 'lead_follow_up'
    || data.source === 'lead_follow_up') return 'leads_follow_up';
  return undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.filter((s): s is string => typeof s === 'string' && !!s.trim()))) : [];
}

export function isOutreachAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

export function getOutreachPolicy(settings: any, activity: OutreachActivityKey): OutreachPolicy | null {
  const raw = settings?.activities?.[activity];
  if (!raw || typeof raw !== 'object') return null;
  if (!validOutreachTiming(raw)) return null;
  const selections = raw.channel_accounts;
  if (selections != null && (typeof selections !== 'object' || Array.isArray(selections)
    || Object.keys(selections).some(key => !isOutreachChannel(key)))) return null;
  const channelAccounts: Record<string, string[]> = { email: [], whatsapp: [] };
  for (const [channel, ids] of Object.entries(selections || {})) channelAccounts[channel] = strings(ids);
  const limit = raw.daily_message_limit === undefined ? 30 : raw.daily_message_limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) return null;
  const maxUnanswered = activity === 'invoices_due' || raw.max_unanswered_messages === undefined ? 3 : raw.max_unanswered_messages;
  if (!Number.isInteger(maxUnanswered) || maxUnanswered < 1 || maxUnanswered > 100) return null;
  const repeatInterval = raw.repeat_interval_days === undefined ? 3 : raw.repeat_interval_days;
  if (activity === 'invoices_due' && (!Number.isInteger(repeatInterval) || repeatInterval < 1 || repeatInterval > 365)) return null;
  const weekdays = raw.weekdays === undefined ? (activity === 'invoices_due' ? [1, 2, 3, 4, 5] : [2, 3, 4]) : raw.weekdays;
  if (activity !== 'leads_initial_cold_outreach' && (!Array.isArray(weekdays)
    || weekdays.some((d: unknown) => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6))) return null;
  return {
    status: raw.status,
    channel_accounts: channelAccounts,
    segment_ids: strings(raw.segment_ids),
    all_segments: raw.all_segments === true,
    daily_message_limit: limit,
    max_unanswered_messages: maxUnanswered,
    weekdays,
    repeat_interval_days: activity === 'invoices_due' ? repeatInterval : 3,
  };
}

export function agentEmailAddress(config: any): string | undefined {
  const username = config?.username || config?.data?.username;
  const domain = config?.domain || config?.data?.domain || config?.customDomain;
  const inbox = config?.inbox_id || config?.id || config?.email;
  const address = username && domain ? `${username}@${domain}` : inbox;
  return typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : undefined;
}

/** Resolve only explicit selections, never the first unselected provider. */
export function selectedOutreachAccounts(settings: any, policy: OutreachPolicy, channel: OutreachChannel): OutreachAccount[] {
  if (!isOutreachChannel(channel)) return [];
  const channels = settings?.channels || {};
  const connections: any[] = Array.isArray(channels.connections) ? channels.connections : [];
  const active = (c: any) => c && c.enabled !== false && ['active', 'synced', 'connected'].includes(c.status);
  return (policy.channel_accounts[channel] || []).slice().sort().flatMap((id): OutreachAccount[] => {
    if (!isOutreachAccountId(id)) return [];
    if (['email', 'agent_email', 'whatsapp', 'agent_whatsapp'].includes(id)) {
      if (channel !== (id === 'email' || id === 'agent_email' ? 'email' : 'whatsapp')) return [];
      const c = channels[id];
      if (!active(c)) return [];
      if (id === 'email' && !c.email) return [];
      if (id === 'agent_email' && !agentEmailAddress(c)) return [];
      if (channel === 'whatsapp' && (!c.account_sid || !(c.existingNumber || c.from_number || c.messaging_service_sid))) return [];
      // No shared-token/provider fallback exists for this legacy account.
      if (id === 'agent_whatsapp' && !c.access_token) return [];
      return [{ id, channel, provider: id as OutreachAccount['provider'], config: c }];
    }
    const matches = connections.filter(c => c?.id === id);
    const c = matches.length === 1 ? matches[0] : undefined;
    if (!c || c.type !== channel || c.status !== 'connected' || c.enabled === false
      || typeof c.zavu_sender_id !== 'string' || !c.zavu_sender_id.trim()) return [];
    if (channel === 'email' && c.metadata?.emailChannelActive === false) return [];
    return [{ id, channel, provider: 'zavu', config: c }];
  });
}

export function selectedOutreachChannels(settings: any, policy: OutreachPolicy): string[] {
  return Object.keys(policy.channel_accounts).filter(channel => selectedOutreachAccounts(settings, policy, channel).length > 0);
}

export function outreachTimezone(settings: any): string {
  const hours = Array.isArray(settings?.business_hours) ? settings.business_hours[0] : settings?.business_hours;
  return hours?.timezone ?? 'America/Mexico_City';
}

export function localDay(now: Date, timezone: string): { day: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday')) };
}

/** Binary search the next local day boundary; respects DST and non-hour offsets. */
export function nextLocalDay(now: Date, timezone: string): Date {
  const day = localDay(now, timezone).day;
  let lo = now.getTime();
  let hi = lo + 48 * 60 * 60 * 1000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(new Date(mid), timezone).day === day) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}