import { createHash } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const fallbackProvider = 'zavu-inbound-message-v2';

export interface InboundBinding { siteId: string; connectionId: string; senderId: string; channel: string }
export interface InboundClaimIdentity {
  provider: string; eventId: string; fallbackMessageId: string | null; bindingHash: string;
}

export function zavuInboundBindingHash(binding: InboundBinding, originMessageId: string, from: string): string {
  return digest(JSON.stringify([binding.siteId, binding.connectionId, binding.senderId, binding.channel, originMessageId, from]));
}

/** Signed sender identity, not the contact, account label or a forwarded site ID. */
export function inboundSender(event: any): string | undefined {
  const ids = [event.senderId, event.data?.senderId, event.sender?.id].filter(id => id != null);
  return present(ids[0]) && ids.every(id => id === ids[0]) ? ids[0] : undefined;
}

export function inboundBinding(sites: any[], senderId: string, channel: unknown, verifiedSiteId?: string): InboundBinding | undefined {
  if (sites.length !== 1 || !present(channel) || channel === 'zavu' || !present(sites[0]?.site_id)) return;
  const { site_id: siteId, channels } = sites[0];
  if ((verifiedSiteId !== undefined && verifiedSiteId !== siteId) || !Array.isArray(channels?.connections)) return;
  const all = channels.connections;
  const matches = all.filter((row: any) => row?.zavu_sender_id === senderId && row.type === channel);
  if (matches.length !== 1 || !present(matches[0].id) || all.filter((row: any) => row?.id === matches[0].id).length !== 1) return;
  return { siteId, senderId, channel, connectionId: matches[0].id };
}

export function inboundClaimIdentity(event: any, rawBody: string, binding: InboundBinding): InboundClaimIdentity | undefined {
  // For well-formed explicit IDs preserve the callback's id || eventId priority.
  const explicit = event.id || event.eventId;
  const message = event.data?.messageId;
  const from = event.data?.from;
  if ((explicit && !present(explicit)) || (message != null && !present(message))
    || (!present(from) && !Number.isSafeInteger(from))) return;
  const fallbackMessageId = !explicit && present(message) ? message : null;
  // The receipt survives re-binding a sender to another site or connection. Its
  // immutable binding is checked separately so a replay cannot follow the move.
  const eventId = fallbackMessageId ? digest(JSON.stringify([binding.senderId, binding.channel, fallbackMessageId]))
    : explicit || digest(rawBody);
  const bindingHash = zavuInboundBindingHash(binding, message || eventId, String(from));
  return { provider: fallbackMessageId ? fallbackProvider : 'zavu', eventId, fallbackMessageId, bindingHash };
}
