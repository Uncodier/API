import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { exactWhatsAppConfig } from '@/lib/messaging/exact-whatsapp';
import { explicitPhone, providerPhone } from './routed-text-identity';
import { textRoutes, type Inbound } from './routed-text-policy';

type LegacyInbound = Inbound & { content: string };
const whatsAppAddress = (value: unknown) => typeof value === 'string' && value.startsWith('whatsapp:')
  ? providerPhone(value) : undefined;

export function isLegacyTwilioTurn(row: Inbound): row is LegacyInbound {
  const d = row.custom_data;
  return d?.source === 'whatsapp' && d.status === 'received' && d.origin_message_id == null
    && typeof d.whatsapp_message_id === 'string' && /^SM[0-9a-f]{32}$/i.test(d.whatsapp_message_id) && !!providerPhone(d.whatsapp_phone)
    && 'content' in row && typeof row.content === 'string' && !!row.content.trim();
}

/** An old CRM row is a lookup hint only. Require Twilio's own inbound record,
 * exact site account and WhatsApp business number, matching content and time. */
export async function verifyLegacyTwilioTurn(siteId: string, row: LegacyInbound): Promise<Inbound | undefined> {
  if (!isLegacyTwilioTurn(row)) return;
  const d = row.custom_data!;
  const sid = d.whatsapp_message_id;
  const from = providerPhone(d.whatsapp_phone);
  const { channels } = await getSiteLicensedResources(siteId);
  const matches: Inbound[] = [];
  for (const route of textRoutes(channels).filter(route => route.provider === 'twilio')) {
    const key = route.connectionId === 'legacy:whatsapp' ? 'whatsapp' : 'agent_whatsapp';
    const config = await exactWhatsAppConfig(siteId, { id: key, channel: 'whatsapp', provider: key, config: channels[key] });
    const account = config?.phoneNumberId;
    const to = explicitPhone(config?.fromNumber);
    if (!config || !account || !/^AC[0-9a-f]{32}$/i.test(account) || !to || !from
      || route.sender !== JSON.stringify([account, config.fromNumber])) continue;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages/${sid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${account}:${config.accessToken}`).toString('base64')}` },
      signal: AbortSignal.timeout(4000), redirect: 'error', cache: 'no-store',
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error('WhatsApp inbound verification unavailable');
    const message = await response.json();
    const received = Date.parse(message?.date_sent || message?.date_created);
    const delta = Date.parse(row.created_at) - received;
    if (message?.sid !== sid || message.account_sid !== account || message.direction !== 'inbound'
      || whatsAppAddress(message.from) !== from || whatsAppAddress(message.to) !== to
      || typeof message.body !== 'string' || message.body.trim() !== row.content.trim()
      || !Number.isFinite(delta) || delta < -60_000 || delta > 15 * 60_000 || received > Date.now()) continue;
    matches.push({ ...row, custom_data: { ...d, origin_message_id: sid,
      twilio_whatsapp_inbound: { sid, account, from, to, received_at: new Date(received).toISOString() } } });
  }
  return matches.length === 1 ? matches[0] : undefined;
}