import { handleWhatsAppAppEcho, isWhatsAppAppEcho } from '../whatsapp-app-echo';
import { findSettingsForSender } from '../webhook-handlers';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('../webhook-handlers', () => ({ findSettingsForSender: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));

const now = Date.parse('2026-11-10T12:00:00Z');
const event = () => ({ type: 'message.sent', id: 'event-one', senderId: 'sender', timestamp: now,
  data: { messageId: 'provider-message', source: 'whatsapp_business_app', direction: 'outbound',
    channel: 'whatsapp', to: '+15555550123', text: 'I can help you' } });
const rpc = jest.fn();
const from = jest.fn(() => { throw new Error('Echo must not look up or insert messages directly'); });
const owner = (site = 'site', connection = 'connection', sender = 'sender') => [{ site_id: site, channels: {
  connections: [{ id: connection, type: 'whatsapp', zavu_sender_id: sender }],
} }];

beforeEach(() => {
  jest.clearAllMocks();
  rpc.mockReset().mockResolvedValue({ data: { state: 'pending' }, error: null });
  jest.mocked(findSettingsForSender).mockResolvedValue(owner() as any);
  (supabaseAdmin.schema as jest.Mock).mockReturnValue({ rpc, from });
});

it('durably registers a first-contact human event without any prior conversation lookup', async () => {
  await expect(handleWhatsAppAppEcho(event(), now)).resolves.toBeUndefined();
  expect(findSettingsForSender).toHaveBeenCalledWith('sender', { skipCache: true });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('register_conversation_human_event', {
    p_site_id: 'site', p_connection_id: 'connection', p_sender_id: 'sender',
    p_recipient: '+15555550123', p_provider_message_id: 'provider-message',
    p_message_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/),
    p_event_at: new Date(now).toISOString(), p_content: 'I can help you',
    p_metadata: expect.objectContaining({ external_human: true, origin: 'zavu',
      source: 'whatsapp_business_app', external_message_id: 'provider-message',
      origin_message_id: 'provider-message', connection_id: 'connection', zavu_sender_id: 'sender',
      channel: 'whatsapp', direction: 'outbound', provider_event_at: new Date(now).toISOString() }),
  });
  expect(from).not.toHaveBeenCalled();
  expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_conversation_id');
  expect(rpc.mock.calls[0][1].p_metadata).not.toHaveProperty('agent_id');
  expect(rpc.mock.calls[0][1].p_metadata).not.toHaveProperty('user_id');
});

it.each(['pending', 'applied', 'duplicate'])('accepts durable RPC state %s', async state => {
  rpc.mockResolvedValue({ data: { state }, error: null });
  await expect(handleWhatsAppAppEcho(event(), now)).resolves.toBeUndefined();
});

it.each([null, undefined, {}, [], [{ state: 'pending' }], { state: 'unknown' }, { state: 'reconciled' },
  { state: true }, { status: 'pending' }])('fails closed on malformed registration result %p', async data => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(handleWhatsAppAppEcho(event(), now)).rejects.toThrow('ZAVU_APP_ECHO_SAVE_FAILED');
});

it('fails closed even if an RPC error includes an apparently successful result', async () => {
  rpc.mockResolvedValue({ data: { state: 'pending' }, error: { code: 'unavailable' } });
  await expect(handleWhatsAppAppEcho(event(), now)).rejects.toThrow('ZAVU_APP_ECHO_SAVE_FAILED');
});

it('propagates RPC transport failures for durable webhook retry', async () => {
  rpc.mockRejectedValue(new Error('database unavailable'));
  await expect(handleWhatsAppAppEcho(event(), now)).rejects.toThrow();
});

it('keeps the deterministic message ID across delivery event IDs and concurrent retries', async () => {
  await Promise.all([handleWhatsAppAppEcho(event(), now),
    handleWhatsAppAppEcho({ ...event(), id: 'event-two' }, now + 1000)]);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
});

it.each(['site', 'connection', 'sender', 'provider'])('isolates deterministic IDs by %s', async scope => {
  await handleWhatsAppAppEcho(event(), now);
  jest.mocked(findSettingsForSender).mockResolvedValue(owner(
    scope === 'site' ? 'other-site' : 'site', scope === 'connection' ? 'other-connection' : 'connection',
    scope === 'sender' ? 'other-sender' : 'sender') as any);
  await handleWhatsAppAppEcho({ ...event(), senderId: scope === 'sender' ? 'other-sender' : 'sender',
    data: { ...event().data, messageId: scope === 'provider' ? 'other-provider-id' : 'provider-message' } }, now);
  expect(rpc.mock.calls[0][1].p_message_id).not.toBe(rpc.mock.calls[1][1].p_message_id);
});

it.each(['15555550123', '+15555550123', 'whatsapp:15555550123', 'whatsapp:+15555550123'])
('canonicalizes only the WhatsApp prefix and plus for %s', async to => {
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, to } }, now);
  expect(rpc.mock.calls[0][1].p_recipient).toBe('+15555550123');
});

it('passes content/recipient conflicts to the atomic RPC without changing their idempotency key', async () => {
  await handleWhatsAppAppEcho(event(), now);
  rpc.mockResolvedValue({ data: null, error: { message: 'scope conflict' } });
  await expect(handleWhatsAppAppEcho({ ...event(), data: { ...event().data,
    text: 'different', to: '+15555550124' } }, now)).rejects.toThrow('ZAVU_APP_ECHO_SAVE_FAILED');
  expect(rpc.mock.calls[0][1].p_message_id).toBe(rpc.mock.calls[1][1].p_message_id);
  expect(rpc.mock.calls[1][1]).toMatchObject({ p_content: 'different', p_recipient: '+15555550124' });
});

it.each([
  { source: 'api' }, { direction: 'inbound' }, { channel: 'sms' }, { messageId: '' },
  { to: '5550123@g.us' }, { to: '' }, { to: '+1 (555) 555-0123' }, { to: '0015555550123' },
  { senderId: 'other' }, { text: '' }, { isHistory: true }, { isHistorical: true }, { history: true },
])('ignores invalid or non-app echo data %p', async patch => {
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, ...patch } }, now);
  expect(rpc).not.toHaveBeenCalled();
});

it('does not accept undocumented echo event types', () => {
  expect(isWhatsAppAppEcho({ ...event(), type: 'whatsapp.message_echo' })).toBe(false);
});

it.each(['site', 'connection'])('rejects ambiguous %s ownership', async ambiguity => {
  const settings = owner();
  if (ambiguity === 'site') settings.push({ ...settings[0], site_id: 'other' });
  else settings[0].channels.connections.push({ id: 'two', type: 'whatsapp', zavu_sender_id: 'sender' });
  jest.mocked(findSettingsForSender).mockResolvedValue(settings as any);
  await handleWhatsAppAppEcho(event(), now);
  expect(rpc).not.toHaveBeenCalled();
});

it('uses original provider time for delayed delivery and clamps future event time', async () => {
  const past = now - 86400000;
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, providerTimestamp: past / 1000 } }, now);
  expect(rpc.mock.calls[0][1].p_event_at).toBe(new Date(past).toISOString());
  await handleWhatsAppAppEcho({ ...event(), timestamp: now + 60000 }, now);
  expect(rpc.mock.calls[1][1].p_event_at).toBe(new Date(now).toISOString());
  expect(rpc.mock.calls[1][1].p_metadata.provider_event_at).toBe(new Date(now + 60000).toISOString());
});

it.each([undefined, 'not-a-date', 0, Infinity])('never substitutes receipt time for invalid timestamp %p', async timestamp => {
  await handleWhatsAppAppEcho({ ...event(), timestamp }, now);
  expect(rpc).not.toHaveBeenCalled();
});

it('stores media placeholders without downloading or persisting untrusted URLs/metadata', async () => {
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, text: '', messageType: 'audio',
    mediaUrl: 'https://untrusted.invalid/media', metadata: { agent_id: 'attacker' } } }, now);
  expect(rpc.mock.calls[0][1].p_content).toBe('[audio]');
  expect(rpc.mock.calls[0][1].p_metadata).toMatchObject({ message_type: 'audio' });
  expect(JSON.stringify(rpc.mock.calls[0][1])).not.toMatch(/untrusted|attacker/);
});

it('selects the configured tenant schema', async () => {
  const previous = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
  process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = 'tenant_test';
  try {
    await handleWhatsAppAppEcho(event(), now);
    expect(supabaseAdmin.schema).toHaveBeenCalledWith('tenant_test');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
    else process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = previous;
  }
});