import { isOutreachChannel } from './policy';
import { getVoiceCallEligibility } from '@/lib/services/zavu/voice-call-consent';

export interface OutreachRecipient {
  channel: string;
  recipient: string;
  source: 'lead_email' | 'lead_phone' | 'social_networks' | 'conversation' | 'legacy_origin';
  conversationId?: string;
}
export interface RecipientInput { siteId: string; lead: any; channel: string; conversations?: any[] }
const E164 = /^\+[1-9]\d{6,14}$/;
const identityKeys = ['channel_user_id', 'chat_id', 'external_user_id', 'recipient_id', 'recipient', 'user_id', 'username', 'id'];
const own = (value: any, key: string): any => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;

/** Public comments / Outstand identities are not direct Zavu conversation IDs. */
export function isNonDirectIdentity(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  return Object.keys(data).some(key => key.startsWith('outstand_') || ['comment_id', 'post_id', 'social_comment_id'].includes(key))
    || /outstand|comment/i.test(String(data.source || ''))
    || /outstand|comment/i.test(String(data.provider || ''))
    || /comment/i.test(String(data.type || ''));
}

function identity(value: unknown): string | undefined {
  // Preserve exact identities; never strip a prefix, country code or URL path.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_@.-]{1,128}$/.test(value)
    || value === '.' || value === '..' || value.includes('..')) return undefined;
  return value;
}
function channelIdentity(value: any, channel: string): string | undefined {
  if (typeof value === 'string') return identity(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || isNonDirectIdentity(value)
    || (value.channel && value.channel !== channel)) return undefined;
  for (const key of identityKeys) {
    const candidate = identity(own(value, key));
    if (candidate) return candidate;
  }
  return undefined;
}

/** Pure, shared generation/delivery contract. Only server-loaded lead/conversations belong here. */
export function resolveOutreachRecipient({ siteId, lead, channel, conversations = [] }: RecipientInput): OutreachRecipient | undefined {
  if (!isOutreachChannel(channel) || !lead || (lead.site_id && lead.site_id !== siteId)) return undefined;
  if (channel === 'email') {
    const recipient = lead.email;
    return typeof recipient === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) && recipient !== 'no-email@example.com'
      ? { channel, recipient, source: 'lead_email' } : undefined;
  }
  if (['sms', 'whatsapp', 'voice'].includes(channel)) {
    if (channel === 'voice' && !getVoiceCallEligibility(lead).allowed) return undefined;
    return typeof lead.phone === 'string' && E164.test(lead.phone) ? { channel, recipient: lead.phone, source: 'lead_phone' } : undefined;
  }
  const scoped = conversations.filter(c => c && c.site_id === siteId && c.lead_id === lead.id && c.channel === channel);
  const known = scoped.filter(c => (!c.custom_data?.channel || c.custom_data.channel === channel) && !isNonDirectIdentity(c.custom_data));
  for (const c of known) {
    const d = c.custom_data || {};
    // Never use c.id (our DB ID), a provider conversation ID, or the agent's sender ID as recipient.
    const recipient = channelIdentity(own(d, channel), channel)
      || channelIdentity(own(d, 'identities')?.[channel], channel)
      || channelIdentity(Object.fromEntries(identityKeys.filter(k => k !== 'id').map(k => [k, own(d, k)])), channel)
      || identity(d.phone) || identity(d.phone_number);
    if (recipient) return { channel, recipient, source: 'conversation', conversationId: c.id };
  }
  // Comment ingestion also writes social_networks / social_handle on the lead.
  // Those are not a direct-message address merely because a connected account
  // shares the platform name. A real direct conversation above can disambiguate.
  const socialOnly = isNonDirectIdentity(lead.metadata) || scoped.some(c => isNonDirectIdentity(c.custom_data))
    || (lead.metadata?.social_network === channel && !!lead.metadata?.social_handle);
  const recipient = !socialOnly && channelIdentity(own(lead.social_networks, channel), channel);
  if (recipient) return { channel, recipient, source: 'social_networks' };
  // Webhook legacy storage puts non-telephone channel identity in phone with origin.
  // A blank follow-up conversation alone never corroborates a telephone-as-chat-ID.
  const legacy = !socialOnly && lead.origin === channel && identity(lead.phone);
  if (legacy && !E164.test(legacy)) return { channel, recipient: legacy, source: 'legacy_origin' };
  return undefined;
}

export function availableOutreachRecipients(input: Omit<RecipientInput, 'channel'> & { channels: string[] }): Record<string, OutreachRecipient> {
  const recipients: Record<string, OutreachRecipient> = {};
  for (const channel of input.channels) {
    const resolved = resolveOutreachRecipient({ ...input, channel });
    if (resolved) recipients[channel] = resolved;
  }
  return recipients;
}