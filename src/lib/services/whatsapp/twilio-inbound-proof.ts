import { claimKey, getCachedJson, sha256 } from '@/lib/security/upstash-rest';
import { providerPhone } from './routed-text-identity';

const DAY = 24 * 60 * 60;
const messageSid = (v: unknown): v is string => typeof v === 'string' && /^SM[0-9a-f]{32}$/i.test(v);
const accountSid = (v: unknown): v is string => typeof v === 'string' && /^AC[0-9a-f]{32}$/i.test(v);
const key = async (sid: string) => `webhook:twilio:agents:${await sha256(sid)}`;

export interface TwilioInboundBinding {
  sid: string; account: string; from: string; to: string; received_at: string;
}

export function isTwilioInboundBinding(value: unknown): value is TwilioInboundBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return messageSid(v.sid) && accountSid(v.account)
    && typeof v.from === 'string' && v.from === providerPhone(v.from)
    && typeof v.to === 'string' && v.to === providerPhone(v.to)
    && typeof v.received_at === 'string' && Number.isFinite(Date.parse(v.received_at));
}

/** Called ONLY after successful Twilio signature and site validation. Preserve
 * the original dedupe key, TTL, SET NX, and unavailable/duplicate behavior. The
 * legacy support workflow forwards neither the account nor the business number. */
export async function claimSignedWhatsAppIngress(siteId: string, webhook: {
  MessageSid: string; AccountSid: string; From: string; To: string; Body: string; NumMedia?: string;
}) {
  const { MessageSid: sid, AccountSid: account, From, To, Body } = webhook;
  const from = providerPhone(From), to = providerPhone(To);
  const plainWhatsApp = from && to && From.startsWith('whatsapp:') && To.startsWith('whatsapp:')
    && siteId && messageSid(sid) && accountSid(account) && typeof Body === 'string' && Body.trim()
    && (webhook.NumMedia === undefined || webhook.NumMedia === '0');
  const value = plainWhatsApp ? JSON.stringify({ siteId, bodyHash: await sha256(Body), sid, account,
    from, to, received_at: new Date().toISOString() }) : '1';
  return claimKey(await key(sid), DAY, 'key-claim', value);
}

/** Resolve the server-owned ingress claim, never trust forwarded metadata or an
 * SID-shaped string. A pre-upgrade '1', expired claim or unavailable cache is
 * not authority to guess the inbound account, window or recipient. */
export async function readTwilioInboundBinding(siteId: string, sid: string, body: string): Promise<TwilioInboundBinding | undefined> {
  if (!siteId || !messageSid(sid)) return;
  const receipt = await getCachedJson<TwilioInboundBinding & { siteId: string; bodyHash: string }>(await key(sid));
  if (!isTwilioInboundBinding(receipt) || receipt.siteId !== siteId || receipt.sid !== sid
    || receipt.bodyHash !== await sha256(body)) return;
  const age = Date.now() - Date.parse(receipt.received_at);
  if (age < 0 || age >= DAY * 1000) return;
  return { sid, account: receipt.account, from: receipt.from, to: receipt.to, received_at: receipt.received_at };
}
