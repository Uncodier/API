import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as receive } from '@/app/api/agents/whatsapp/route';
import { saveMessages } from '@/app/api/agents/customerSupport/message/save-messages';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { claimKey, getCachedJson, sha256 } from '@/lib/security/upstash-rest';
import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';
import { findWhatsAppConfiguration, processIncomingMessage } from '@/lib/services/twilio/TwilioIncomingService';
import { sendRoutedText } from '../routed-text';
import { attemptRoutedText } from '../routed-text-provider';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), schema: jest.fn() } }));
jest.mock('@/lib/billing/licensed-resources', () => ({ ...jest.requireActual('@/lib/billing/licensed-resources'), getSiteLicensedResources: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({ ...jest.requireActual('@/lib/security/upstash-rest'), claimKey: jest.fn(), getCachedJson: jest.fn() }));
jest.mock('@/lib/services/twilio/TwilioIncomingService', () => ({ findWhatsAppConfiguration: jest.fn(), processIncomingMessage: jest.fn() }));
jest.mock('@/lib/services/twilio/TwilioMediaTaskService', () => ({}));
jest.mock('@/lib/services/social-comments/persistence', () => ({}));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));
jest.mock('../routed-text-provider', () => ({ attemptRoutedText: jest.fn() }));

type Row = Record<string, any>;
const siteId = randomUUID(), userId = randomUUID(), leadId = randomUUID(), agentId = randomUUID();
const account = `AC${randomBytes(16).toString('hex')}`, sid = `SM${randomBytes(16).toString('hex')}`;
const business = '+14155550101', customer = '+14155550100', text = 'Can you confirm my appointment?';
const reply = 'Yes, your appointment is confirmed.';
const secret = randomBytes(32).toString('hex');
const url = 'https://api.example.test/api/agents/whatsapp';
const fields = { MessageSid: sid, AccountSid: account, From: `whatsapp:${customer.slice(1)}`, To: `whatsapp:${business}`, Body: text, NumMedia: '0' };
let rows: Record<string, Row[]>;
let claims: Map<string, string>;

/** Table-level fake, including the relationship scope and the receipt's CAS. */
function query(table: string) {
  if (!(table in rows)) throw new Error(`Unexpected test table: ${table}`);
  const filters: Array<(r: Row) => boolean> = []; let inserts: Row[] | undefined, update: Row | undefined;
  const read = () => rows[table].filter(r => filters.every(f => f(r)));
  const execute = () => {
    if (inserts) {
      const added = inserts.map(row => ({ id: randomUUID(), created_at: new Date().toISOString(), ...row }));
      rows[table].push(...added); return added;
    }
    const found = read(); if (update) found.forEach(row => Object.assign(row, update)); return found;
  };
  const q: any = {
    select: () => q, order: () => q, limit: () => q,
    eq: (key: string, value: unknown) => { filters.push(row => {
      if (key === 'conversations.site_id') return rows.conversations.some(c => c.id === row.conversation_id && c.site_id === value);
      if (key === 'custom_data') return JSON.stringify(row.custom_data) === value;
      return row[key] === value;
    }); return q; },
    filter: (key: string, _: string, value: unknown) => { filters.push(row => String(row.custom_data?.[key.replace('custom_data->>', '')]) === value); return q; },
    in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return q; },
    insert: (value: Row | Row[]) => { inserts = Array.isArray(value) ? value : [value]; return q; },
    update: (value: Row) => { update = value; return q; },
    single: async () => ({ data: execute()[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: execute(), error: null }),
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks(); claims = new Map();
  rows = { conversations: [], messages: [], leads: [{ id: leadId, site_id: siteId, phone: customer.slice(1) }], visitors: [] };
  jest.mocked(supabaseAdmin.from).mockImplementation(query as any);
  jest.mocked(supabaseAdmin.schema).mockReturnValue(supabaseAdmin as any);
  jest.mocked(findWhatsAppConfiguration).mockResolvedValue({ siteId, agentId, success: true });
  // Verify signatures using the real algorithm, with a synthetic test-only key.
  jest.spyOn(TwilioValidationService, 'validateTwilioRequest').mockImplementation(async (url, data, signature) =>
    ({ isValid: TwilioValidationService.validateSignature(url, data, signature, secret) }));
  jest.mocked(processIncomingMessage).mockResolvedValue({ success: true });
  jest.mocked(claimKey).mockImplementation(async (key, _ttl, _op, value = '1') => {
    if (claims.has(key)) return { state: 'contended' }; claims.set(key, value); return { state: 'acquired' };
  });
  jest.mocked(getCachedJson).mockImplementation(async key => JSON.parse(claims.get(key) || 'null'));
  jest.mocked(getSiteLicensedResources).mockResolvedValue({ channels: {
    connections: [{ type: 'whatsapp', status: 'connected', license_suspended: false, id: 'other-provider', zavu_sender_id: 'other-sender' }],
    whatsapp: { status: 'active', account_sid: account, from_number: business },
    agent_whatsapp: { status: 'active', account_sid: account, from_number: '+14155550102' },
  }, social_media: [], effective_plan: 'foundry' });
  jest.mocked(attemptRoutedText).mockImplementation(async input => {
    await input.verifyBinding(); return { kind: 'accepted', providerMessageId: 'test-receipt' };
  });
});
afterEach(() => jest.restoreAllMocks());

async function webhook(valid = true, data: Record<string, string> = fields) {
  const signingString = url + Object.keys(data).sort().map(k => k + data[k]).join('');
  const signature = createHmac('sha1', valid ? secret : randomBytes(32)).update(signingString).digest('base64');
  return receive(new NextRequest(url, { method: 'POST', body: new URLSearchParams(data), headers: { 'x-twilio-signature': signature } }));
}
function save(options: { approval?: boolean; body?: string; site?: string; conversation?: string; data?: Row; disabled?: boolean;
  robot?: boolean; transactional?: boolean; erratic?: boolean; channel?: string; channelDelivery?: boolean; audio?: boolean; media?: boolean } = {}) {
  return saveMessages(userId, options.body ?? text, reply, options.conversation, undefined, leadId, undefined, agentId,
    options.site ?? siteId, undefined, options.channel ?? 'whatsapp', options.robot, options.transactional, options.erratic,
    sid, options.channelDelivery ?? false, options.approval ?? false, { automation_started_at: new Date().toISOString(), ...options.data },
    options.disabled, options.audio ? 'audio' : 'text', options.media ? { message_type: 'image', media_url: 'https://media.example.test/image' } : undefined);
}
function identity() {
  const row = rows.messages.find(r => r.role === 'assistant')!;
  return { site_id: siteId, conversation_id: row.conversation_id as string, message_id: row.id as string };
}

it('routes the actual legacy support row once, on the signed business account/number and correct +1 recipient', async () => {
  expect((await webhook()).status).toBe(200);
  // Duplicate claim: do not overwrite the first signed contact or receipt time.
  expect(await (await webhook(true, { ...fields, From: 'whatsapp:+14155550109' })).json()).toMatchObject({ duplicate: true });
  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(claimKey).toHaveBeenCalledWith(`webhook:twilio:agents:${await sha256(sid)}`, 86400, 'key-claim', expect.any(String));
  const saved = await save();
  const [inbound, assistant] = rows.messages;
  expect(inbound.custom_data).toMatchObject({ origin_message_id: sid, twilio_whatsapp_inbound: { sid, account, from: customer, to: business } });
  expect(assistant).toMatchObject({ id: saved?.assistantMessageId, role: 'assistant', custom_data: {
    status: 'ready', channel: 'whatsapp', response_format: 'text', whatsapp_support_inbound_id: saved?.userMessageId,
  } });
  for (let i = 0; i < 2; i++) expect(await sendRoutedText(identity())).toMatchObject({ status: 'accepted', provider: 'twilio' });
  expect(attemptRoutedText).toHaveBeenCalledTimes(1);
  expect(attemptRoutedText).toHaveBeenCalledWith(expect.objectContaining({ text: reply, recipient: customer, forceTemplate: false,
    route: { provider: 'twilio', connectionId: 'legacy:whatsapp', sender: JSON.stringify([account, business]) } }));
});

it.each(['unsigned','old-claim','wrong-site','wrong-body','future','expired','sms'])('%s is not authenticated WhatsApp ingress for this support turn', async reason => {
  const redisKey = `webhook:twilio:agents:${await sha256(sid)}`;
  if (reason === 'unsigned') { expect((await webhook(false)).status).toBe(403); expect(claimKey).not.toHaveBeenCalled(); }
  else if (reason === 'old-claim') claims.set(redisKey, '1');
  else if (reason === 'sms') await webhook(true, { ...fields, From: customer, To: business });
  else {
    await webhook();
    if (['future','expired'].includes(reason)) {
      const record = JSON.parse(claims.get(redisKey)!);
      record.received_at = new Date(Date.now() + (reason === 'future' ? 5000 : -86401_000)).toISOString();
      claims.set(redisKey, JSON.stringify(record));
    }
  }
  await save({ body: reason === 'wrong-body' ? 'Different question' : text, site: reason === 'wrong-site' ? randomUUID() : siteId,
    data: { twilio_whatsapp_inbound: { sid, account, to: business, from: customer, received_at: new Date().toISOString() } } });
  expect(rows.messages[0].custom_data.twilio_whatsapp_inbound).toBeUndefined();
  expect(rows.messages[1].custom_data.status).not.toBe('ready');
  expect(rows.messages[1].custom_data.whatsapp_support_inbound_id).toBeUndefined();
  expect(attemptRoutedText).not.toHaveBeenCalled();
});

it('approval stays pending; a later unverified turn cannot borrow the verified inbound', async () => {
  await webhook(); const saved = await save({ approval: true });
  expect(rows.messages[1].custom_data.status).toBe('pending');
  await expect(sendRoutedText(identity())).rejects.toThrow();
  const unproven = await save({ conversation: saved?.conversationId, body: 'Unknown source' });
  const row = rows.messages.find(r => r.id === unproven?.assistantMessageId)!;
  expect(row.custom_data.status).not.toBe('ready');
  await expect(sendRoutedText({ ...identity(), message_id: row.id })).rejects.toThrow();
  expect(attemptRoutedText).not.toHaveBeenCalled();
});

it('a changed/deleted original turn cannot be replaced by another turn on the same number', async () => {
  await webhook(); await save();
  rows.messages[0].id = randomUUID();
  await expect(sendRoutedText(identity())).rejects.toThrow('original inbound');
  expect(attemptRoutedText).not.toHaveBeenCalled();
});

it('re-checks the original signed business number even if the legacy settings slot still exists', async () => {
  await webhook(); await save();
  jest.mocked(getSiteLicensedResources).mockResolvedValue({ channels: { connections: [],
    whatsapp: { status: 'active', account_sid: account, from_number: '+14155550109' },
  }, social_media: [], effective_plan: 'foundry' });
  expect(await sendRoutedText(identity())).toMatchObject({ success: false, status: 'failed' });
  expect(attemptRoutedText).not.toHaveBeenCalled();
});

it.each([{disabled: true}, {channel: 'email'}, {channel: 'telegram'}, {channelDelivery: true}, {media: true}, {audio: true}])(
  'does not give automatic plain-text eligibility to %j', async options => {
    await webhook(); await save(options);
    expect(rows.messages).toHaveLength(2);
    expect(rows.messages[1].custom_data.status).not.toBe('ready');
    if ('disabled' in options) expect(rows.messages[1]).toMatchObject({ role: 'system', custom_data: { internal: true, response_skipped: true } });
  });

it.each([{robot: true}, {erratic: true}, {transactional: true}])('retains skip-database for %j', async options => {
  await webhook(); await expect(save(options)).rejects.toThrow('SKIP_DATABASE');
  expect(rows.messages).toHaveLength(0); expect(rows.conversations).toHaveLength(0);
});

it('cannot retarget a different saved lead during support persistence', async () => {
  const chat = randomUUID(), oldLead = randomUUID();
  rows.conversations.push({ id: chat, site_id: siteId, channel: 'whatsapp', lead_id: oldLead });
  await webhook(); await expect(save({ conversation: chat })).resolves.toBeNull();
  expect(rows.conversations[0].lead_id).toBe(oldLead); expect(rows.messages).toHaveLength(0);
});
