import { randomBytes } from 'node:crypto';
import { textRoutes, textRoutePlan, hasTextWindow } from '../routed-text-policy';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));

const row = (id: string, overrides: Record<string, unknown> = {}) => ({ id, type: 'whatsapp', status: 'connected',
  zavu_sender_id: `sender-${id}`, license_suspended: false, ...overrides });
const legacy = { status: 'active', account_sid: 'account', from_number: '+15555550102' };
const routes = () => textRoutes({ connections: [row('z1'), row('z2')], whatsapp: legacy });

it('keeps only active licensed WhatsApp connections, in site order, then distinct Twilio accounts', () => {
  const connections = [row('sms', { type: 'sms' }), row('z2'), row('disabled', { enabled: false }),
    row('suspended', { license_suspended: true }), row('hidden', { _license: { manually_disabled: true } }),
    row('inactive', { metadata: { provider_channel_active: false } }), row('unbound', { zavu_sender_id: '' }), row('z1')];
  expect(textRoutes({ connections, whatsapp: legacy, agent_whatsapp: legacy }).map(r => r.connectionId))
    .toEqual(['z2', 'z1', 'legacy:whatsapp']);
});

it('does not reinterpret an explicit pin (including stale, empty or mixed inbound IDs) as permission for another sender', () => {
  expect(textRoutePlan(routes(), { connection_id: 'removed' }, {}, [])).toEqual([]);
  expect(() => textRoutePlan(routes(), { connection_id: null }, {}, [])).toThrow('Invalid');
  expect(() => textRoutePlan(routes(), { connection_id: 'z1' }, { connection_id: 'z2' }, [])).toThrow('Conflicting');
  expect(() => textRoutePlan(routes(), {}, {}, [{ created_at: '', custom_data: {} }])).toThrow('unknown');
  expect(textRoutePlan(routes(), {}, {}, [{ created_at: '', custom_data: { connection_id: 'z2', zavu_sender_id: 'sender-z2' } }]))
    .toEqual([routes()[1]]);
});

it('never borrows another sender, recipient or a stale response window', () => {
  const created_at = '2026-11-20T12:00:00Z';
  const inbound = [{ created_at, custom_data: { source: 'zavu_inbound_message', channel: 'whatsapp', connection_id: 'z2',
    zavu_sender_id: 'sender-z2', zavu_from: 'whatsapp:+15555550100' } }];
  const now = Date.parse(created_at) + 1000;
  expect(hasTextWindow(routes()[1], inbound, '+15555550100', now)).toBe(true);
  expect(hasTextWindow(routes()[0], inbound, '+15555550100', now)).toBe(false);
  expect(hasTextWindow(routes()[1], inbound, '+15555550101', now)).toBe(false);
  expect(hasTextWindow(routes()[1], inbound, '+15555550100', now + 86400_000)).toBe(false);
});

it('a conversation-bound sender may fail over only to a provable same-number alias; exact messages stay pinned', () => {
  const channels = { connections: [row('primary', { connected_account: { whatsapp: { displayPhoneNumber: '+1 555 555 0102' } } }), row('other')], whatsapp: legacy };
  const inventory = textRoutes(channels);
  expect(textRoutePlan(inventory, {}, { connection_id: 'primary' }, [], channels).map(r => r.connectionId))
    .toEqual(['primary', 'legacy:whatsapp']);
  expect(textRoutePlan(inventory, { connection_id: 'primary' }, {}, [], channels).map(r => r.connectionId)).toEqual(['primary']);
});
it.each([
  { connected_account: { phoneNumber: legacy.from_number } },
  { metadata: { routing: { phone_number: legacy.from_number }, phone_number: legacy.from_number } },
  { connected_account: { channel: 'sms', whatsapp: { displayPhoneNumber: legacy.from_number } } },
  { connected_account: { whatsapp: { displayPhoneNumber: legacy.from_number } }, whatsapp: { displayPhoneNumber: '+15555550109' } },
])('does not infer a same-number alias from a generic or conflicting number %j', data => {
  const channels = { connections: [row('z', data)], whatsapp: legacy };
  expect(textRoutePlan(textRoutes(channels), {}, { connection_id: 'z' }, [], channels).map(r => r.connectionId)).toEqual(['z']);
});

it('rejects provider conflicts even within one saved row', () => {
  expect(() => textRoutePlan(routes(), { delivery_provider: 'twilio', provider: 'zavu' }, {}, [])).toThrow('Conflicting');
});

it.each(['14155550100', '+14155550100', 'whatsapp:14155550100', 'whatsapp:+14155550100'])(
  'matches window and verified inbound destination with the same canonicalization (%s)', from => {
    const inbound = [{ created_at: new Date().toISOString(), custom_data: { source: 'zavu_inbound_message',
      connection_id: 'z2', zavu_sender_id: 'sender-z2', channel: 'whatsapp', zavu_from: from } }];
    expect(hasTextWindow(routes()[1], inbound, '+14155550100', Date.now())).toBe(true);
    expect(hasTextWindow(routes()[1], inbound, '+5214155550100', Date.now())).toBe(false);
    expect(hasTextWindow(routes()[0], inbound, '+14155550100', Date.now())).toBe(false);
  });

it('a provider preference, record ID or sole configured sender is not legacy ingress provenance', () => {
  const one = textRoutes({ connections: [], whatsapp: legacy });
  for (const d of [{}, { origin_message_id: `SM${randomBytes(16).toString('hex')}` },
    { provider: 'twilio', whatsapp_phone: '+14155550100' }]) {
    const inbound = [{ custom_data: d, created_at: new Date().toISOString() }];
    expect(() => textRoutePlan(one, {}, { provider: 'twilio' }, inbound)).toThrow('unknown');
    expect(hasTextWindow(one[0], inbound, '+14155550100', Date.now())).toBe(false);
  }
});

it('the legacy window is specific to signed account + To + From + ingress time, not a settings slot or later support save', () => {
  const account = `AC${randomBytes(16).toString('hex')}`, sid = `SM${randomBytes(16).toString('hex')}`;
  const channels = { connections: [row('z', { connected_account: { whatsapp: { displayPhoneNumber: legacy.from_number } } })],
    whatsapp: { ...legacy, account_sid: account }, agent_whatsapp: { ...legacy, account_sid: account, from_number: '+15555550103' } };
  const [zavu, exact, differentFrom] = textRoutes(channels);
  const changedAccount = { ...exact, sender: JSON.stringify(['another-account', legacy.from_number]) };
  const now = Date.now(), received_at = new Date(now - 23 * 3600_000).toISOString();
  const proof = { sid, account, from: '+14155550100', to: legacy.from_number, received_at };
  const inbound = [{ custom_data: { origin_message_id: sid, twilio_whatsapp_inbound: proof }, created_at: new Date(now).toISOString() }];
  expect(textRoutePlan([zavu, exact, differentFrom], {}, {}, inbound, channels)).toEqual([exact, zavu]);
  expect(textRoutePlan([differentFrom, changedAccount], {}, {}, inbound)).toEqual([]);
  expect(hasTextWindow(exact, inbound, '+14155550100', now)).toBe(true);
  for (const other of [zavu, differentFrom, changedAccount]) expect(hasTextWindow(other, inbound, '+14155550100', now)).toBe(false);
  expect(hasTextWindow(exact, inbound, '+14155550101', now)).toBe(false);
  expect(hasTextWindow(exact, inbound, '+14155550100', now + 3600_000)).toBe(false);
  expect(hasTextWindow(exact, inbound, '+14155550100', Date.parse(received_at) - 1)).toBe(false);
  expect(() => textRoutePlan([exact, differentFrom], {}, {}, [...inbound, {
    ...inbound[0], custom_data: { origin_message_id: sid, twilio_whatsapp_inbound: { ...proof, to: channels.agent_whatsapp.from_number } },
  }])).toThrow('Conflicting');
});

it('does not reinterpret an inactive sender or an ambiguous duplicate slot as the active sender', () => {
  const channels = { connections: [row('old', { enabled: false, zavu_sender_id: 'shared' }), row('new', { zavu_sender_id: 'shared' })] };
  expect(() => textRoutes(channels)).toThrow('Ambiguous WhatsApp sender');
});
