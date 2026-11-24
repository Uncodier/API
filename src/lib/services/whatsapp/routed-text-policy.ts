import { isLicensedChannelConnection, type LicensedResources } from '@/lib/billing/licensed-resources';
import type { TextRoute } from './routed-text-provider';
import { explicitPhone, providerPhone, RoutedTextRecipientError } from './routed-text-identity';
import { isTwilioInboundBinding } from './twilio-inbound-proof';

const present = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v;

/** Only site inventory, never environment credentials or another tenant's sender.
 * Keep configured connection order, then the two legacy Twilio accounts. */
export function textRoutes(channels: LicensedResources['channels']): TextRoute[] {
  const routes: TextRoute[] = [];
  const ids = new Set<string>();
  // A disabled sender may still own an inbound thread. The same sender ID in
  // two configured slots cannot prove an exact account, even if only one slot
  // is currently dispatchable.
  for (const row of channels.connections) {
    if (row.type !== 'whatsapp') continue;
    if (!present(row.id) || row.id.startsWith('legacy:') || ['email', 'agent_email', 'whatsapp', 'agent_whatsapp'].includes(row.id) || ids.has(row.id)
      || channels.connections.some(other => other !== row && other.id === row.id)) throw new Error('Ambiguous WhatsApp connection');
    ids.add(row.id);
    if (!isLicensedChannelConnection('whatsapp', row) || !present(row.zavu_sender_id)
      || row.metadata?.provider_channel_active === false || row.metadata?.activation_pending === true) continue;
    if (channels.connections.some(other => other !== row && other.type === 'whatsapp' && other.zavu_sender_id === row.zavu_sender_id)) {
      throw new Error('Ambiguous WhatsApp sender');
    }
    routes.push({ provider: 'zavu', connectionId: row.id, sender: row.zavu_sender_id });
  }
  for (const key of ['whatsapp', 'agent_whatsapp']) {
    const row = channels[key];
    const from = row?.existingNumber || row?.from_number;
    if (!row || !['connected', 'synced', 'active'].includes(row.status) || row.enabled === false
      || row._license?.manually_disabled || row.license_suspended || !present(row.account_sid) || !present(from)) continue;
    const sender = JSON.stringify([row.account_sid, from]);
    if (!routes.some(r => r.provider === 'twilio' && r.sender === sender)) {
      routes.push({ provider: 'twilio', connectionId: `legacy:${key}`, sender });
    }
  }
  return routes;
}

type Metadata = Record<string, any>;
export type Inbound = { id?: string; lead_id?: string | null; visitor_id?: string | null; custom_data: Metadata | null; created_at: string };
type InboundIdentity = {
  provider: 'twilio' | 'zavu'; recipient: string; receivedAt: string;
  connectionId?: string; zavuSender?: string; account?: string; business?: string;
};
const conflict = () => new Error('Conflicting WhatsApp sender history');

/** Extract destination and window evidence from the same saved inbound record.
 * Caller hints and normal outbound/contact fields can constrain, not create it. */
export function verifiedTextInbound(row: Inbound): InboundIdentity | undefined {
  const d = row.custom_data;
  if (!d) return;
  const twilio = d.twilio_whatsapp_inbound;
  if ('twilio_whatsapp_inbound' in d) {
    if (!isTwilioInboundBinding(twilio) || twilio.sid !== d.origin_message_id
      || (d.channel != null && d.channel !== 'whatsapp') || d.zavu_sender_id || d.source === 'zavu_inbound_message'
      || (d.provider != null && !['twilio','whatsapp'].includes(d.provider)) || d.channel_delivery === true
      || [d.account_sid, d.twilio_account_sid].some(v => v != null && v !== twilio.account)
      || [d.twilio_message_sid, d.twilio_message_id].some(v => v != null && v !== twilio.sid)
      || [d.to, d.to_number].some(v => v != null && providerPhone(v) !== twilio.to)) throw conflict();
    return { provider: 'twilio', recipient: twilio.from, receivedAt: twilio.received_at, account: twilio.account, business: twilio.to };
  }
  if (d.source === 'zavu_inbound_message') {
    if (d.channel !== 'whatsapp' || !present(d.connection_id) || !present(d.zavu_sender_id)
      || d.twilio_message_sid || d.twilio_message_id || (d.provider != null && !['zavu','whatsapp'].includes(d.provider))) throw conflict();
    const recipient = providerPhone(d.zavu_from);
    if (!recipient) throw new RoutedTextRecipientError();
    return { provider: 'zavu', recipient, receivedAt: row.created_at, connectionId: d.connection_id, zavuSender: d.zavu_sender_id };
  }
  // A provider name, mutable connection slot or SID-shaped origin ID alone
  // is not evidence of which WhatsApp account/number received a message.
  return undefined;
}

export function inboundRecipient(inbound: Inbound[]): string | undefined {
  const addresses = new Set(inbound.map(verifiedTextInbound).map(v => v?.recipient).filter(v => v !== undefined));
  if (addresses.size > 1) throw new RoutedTextRecipientError();
  return addresses.values().next().value;
}

function matchesInboundRoute(route: TextRoute, turn: InboundIdentity) {
  if (route.provider !== turn.provider) return false;
  if (turn.provider === 'zavu') return route.connectionId === turn.connectionId && route.sender === turn.zavuSender;
  // textRoutes constructs this key with the *actual* account and From. A
  // replaced legacy:whatsapp settings slot cannot take over the old window.
  const [account, from] = JSON.parse(route.sender);
  return account === turn.account && explicitPhone(from) === turn.business;
}

/** Only a WhatsApp-specific business number proves an alias. The generic
 * connected_account.phoneNumber and metadata.phone_number may be SMS/voice. */
function businessNumber(channels: LicensedResources['channels'] | undefined, route: TextRoute) {
  if (!channels) return undefined;
  if (route.provider === 'twilio') {
    const row = channels[route.connectionId.slice('legacy:'.length)];
    return explicitPhone(row?.existingNumber || row?.from_number);
  }
  const row = channels.connections.find(c => c.id === route.connectionId && c.zavu_sender_id === route.sender);
  if (!row || (row.connected_account?.channel != null && row.connected_account.channel !== 'whatsapp')) return undefined;
  const values = [row.connected_account?.whatsapp?.displayPhoneNumber, row.whatsapp?.displayPhoneNumber].filter(v => v != null);
  const numbers = new Set(values.map(explicitPhone));
  return numbers.size === 1 ? numbers.values().next().value : undefined;
}

/** Explicit selections and inbound conversations are not an interchangeable pool of senders. */
export function textRoutePlan(inventory: TextRoute[], message: Metadata, conversation: Metadata, inbound: Inbound[], channels?: LicensedResources['channels']) {
  const bindings = new Set<string>();
  const senders = new Set<string>();
  const providers = new Set<'zavu' | 'twilio'>();
  for (const data of [message, conversation, ...inbound.map(row => row.custom_data || {})]) {
    if (data.channel != null && data.channel !== 'whatsapp') throw new Error('Conflicting WhatsApp channel');
    if ('connection_id' in data) {
      if (!present(data.connection_id)) throw new Error('Invalid stored WhatsApp connection');
      bindings.add(data.connection_id);
    }
    if ('zavu_sender_id' in data) {
      if (!present(data.zavu_sender_id)) throw new Error('Invalid stored WhatsApp sender');
      senders.add(data.zavu_sender_id);
    }
    for (const provider of [data.channel_delivery?.provider, data.delivery_provider, data.provider]) {
      if (provider === 'twilio' || provider === 'zavu') providers.add(provider);
      else if (provider != null && provider !== 'whatsapp') throw new Error('Unsupported WhatsApp provider');
    }
    if (data.twilio_whatsapp_inbound || data.twilio_message_id || data.twilio_message_sid) providers.add('twilio');
    if (data.channel_delivery === true || data.source === 'zavu_inbound_message' || data.zavu_sender_id) providers.add('zavu');
  }
  const turns = inbound.map(verifiedTextInbound).filter((v): v is InboundIdentity => v !== undefined);
  const legacySenders = new Set(turns.filter(v => v.provider === 'twilio').map(v => JSON.stringify([v.account, v.business])));
  if (new Set(turns.map(v => v.recipient)).size > 1) throw new RoutedTextRecipientError();
  if (bindings.size > 1 || senders.size > 1 || providers.size > 1 || legacySenders.size > 1) throw conflict();
  const exact = bindings.size > 0 || senders.size > 0 || legacySenders.size > 0;
  if (!exact && inbound.length) throw new Error('Inbound WhatsApp sender is unknown');
  let routes = inventory.filter(r => (!bindings.size || bindings.has(r.connectionId)) && (!senders.size || senders.has(r.sender))
    && (!providers.size || providers.has(r.provider)) && turns.every(turn => matchesInboundRoute(r, turn)));
  if (exact && routes.length > 1) throw new Error('Inbound conversation requires an exact WhatsApp sender');
  // Keep explicit per-message choices strict. A conversation-bound backup
  // needs an independently proven same WhatsApp business number, not a label.
  if (exact && routes.length === 1 && !('connection_id' in message) && !('zavu_sender_id' in message)) {
    const primary = routes[0];
    const number = businessNumber(channels, primary);
    if (number) routes.push(...inventory.filter(r => r !== primary && businessNumber(channels, r) === number));
  }
  // A provider preference alone in a fresh chat orders connections; it is not an exact account pin.
  if (!exact && !inbound.length && providers.size) routes = [...routes, ...inventory.filter(r => !providers.has(r.provider))];
  return routes;
}

/** Even a same-business-number backup may not borrow the primary's window. */
export function hasTextWindow(route: TextRoute, inbound: Inbound[], recipient: string, now: number): boolean {
  return inbound.some(row => {
    const turn = verifiedTextInbound(row);
    if (!turn || turn.recipient !== recipient || !matchesInboundRoute(route, turn)) return false;
    const age = now - Date.parse(turn.receivedAt);
    return age >= 0 && age < 24 * 60 * 60 * 1000;
  });
}
