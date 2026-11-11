import { handleWhatsAppAppEcho, isWhatsAppAppEcho } from '../whatsapp-app-echo';
import { findSettingsForSender } from '../webhook-handlers';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('../webhook-handlers', () => ({ findSettingsForSender: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));

const now = Date.parse('2026-11-10T12:00:00Z');
const event = () => ({ type: 'message.sent', id: 'event-one', senderId: 'sender', timestamp: now,
  data: { messageId: 'provider-message', source: 'whatsapp_business_app', direction: 'outbound',
    channel: 'whatsapp', to: '+15555550123', text: 'I can help you' } });
let rows: any[];
let saved: any[];
let queries: any[];
let failInsert: boolean;
let failLookup: boolean;
beforeEach(() => {
  jest.clearAllMocks();
  rows = [{ conversation_id: 'conversation', custom_data: { zavu_from: 'whatsapp:+15555550123' } }];
  saved = []; queries = []; failInsert = false; failLookup = false;
  jest.mocked(findSettingsForSender).mockResolvedValue([{ site_id: 'site', channels: {
    connections: [{ id: 'connection', type: 'whatsapp', zavu_sender_id: 'sender' }],
  } }] as any);
  (supabaseAdmin.schema as jest.Mock).mockImplementation(() => ({ from: (table: string) => {
    expect(table).toBe('messages');
    const filters: Record<string, any> = {};
    const q: any = {
      select: jest.fn(() => q), eq: jest.fn((key, value) => { filters[key] = value; return q; }),
      order: jest.fn(() => q), limit: jest.fn(() => q),
      maybeSingle: jest.fn(async () => {
        queries.push(filters);
        if (failLookup) return { error: { code: 'unavailable' } };
        return { data: filters.id ? saved.find(row => row.id === filters.id) || null
          : rows.find(row => row.custom_data.zavu_from === filters['custom_data->>zavu_from']) || null };
      }),
      insert: jest.fn(async row => {
        if (failInsert) return { error: { code: 'unavailable' } };
        if (saved.some(existing => existing.id === row.id)) return { error: { code: '23505' } };
        saved.push(row); return { error: null };
      }),
    };
    return q;
  } }));
});

it('persists exact-scoped external human without assigning an owner or modifying a conversation', async () => {
  await handleWhatsAppAppEcho(event(), now);
  expect(findSettingsForSender).toHaveBeenCalledWith('sender', { skipCache: true });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ conversation_id: 'conversation', role: 'team_member', user_id: null,
    created_at: new Date(now).toISOString(), custom_data: { external_human: true, origin: 'zavu',
      source: 'whatsapp_business_app', external_message_id: 'provider-message',
      connection_id: 'connection', zavu_sender_id: 'sender', zavu_from: 'whatsapp:+15555550123' } });
  expect(saved[0]).not.toHaveProperty('agent_id');
  expect(queries.filter(q => !q.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ 'conversations.site_id': 'site', role: 'user',
      'custom_data->>connection_id': 'connection', 'custom_data->>zavu_sender_id': 'sender' }),
  ]));
});

it('deduplicates a provider message across event IDs even when conversation lookup changes', async () => {
  await handleWhatsAppAppEcho(event(), now);
  rows = [];
  await handleWhatsAppAppEcho({ ...event(), id: 'event-two' }, now + 1000);
  expect(saved).toHaveLength(1);
});

it('handles concurrent inserts with the deterministic primary key', async () => {
  await Promise.all([handleWhatsAppAppEcho(event(), now), handleWhatsAppAppEcho({ ...event(), id: 'two' }, now)]);
  expect(saved).toHaveLength(1);
});

it('rejects provider-ID reuse for a different recipient or content', async () => {
  await handleWhatsAppAppEcho(event(), now);
  await expect(handleWhatsAppAppEcho({ ...event(), data: { ...event().data, text: 'different' } }, now))
    .rejects.toThrow('SCOPE_CONFLICT');
});

it.each([
  { source: 'api' }, { direction: 'inbound' }, { channel: 'sms' }, { messageId: '' },
  { to: '5550123@g.us' }, { to: '' }, { senderId: 'other' }, { text: '' }, { isHistory: true },
])('ignores invalid or non-app echo data %p', async patch => {
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, ...patch } }, now);
  expect(saved).toHaveLength(0);
});

it('does not accept undocumented echo event types', () => {
  expect(isWhatsAppAppEcho({ ...event(), type: 'whatsapp.message_echo' })).toBe(false);
});

it('requires existing conversation and rejects ambiguous normalized recipients', async () => {
  rows = [];
  await expect(handleWhatsAppAppEcho(event(), now)).rejects.toThrow('CONVERSATION_NOT_READY');
  expect(saved).toHaveLength(0);
  rows = ['+15555550123', 'whatsapp:+15555550123'].map((from, i) => ({
    conversation_id: `conversation-${i}`, custom_data: { zavu_from: from },
  }));
  await handleWhatsAppAppEcho(event(), now);
  expect(saved).toHaveLength(0);
});

it.each(['site', 'connection'])('rejects ambiguous %s ownership', async ambiguity => {
  const settings: any = [{ site_id: 'site', channels: { connections: [
    { id: 'one', type: 'whatsapp', zavu_sender_id: 'sender' },
  ] } }];
  if (ambiguity === 'site') settings.push({ ...settings[0], site_id: 'other' });
  else settings[0].channels.connections.push({ id: 'two', type: 'whatsapp', zavu_sender_id: 'sender' });
  jest.mocked(findSettingsForSender).mockResolvedValue(settings);
  await handleWhatsAppAppEcho(event(), now);
  expect(saved).toHaveLength(0);
});

it('uses original provider time for delayed delivery, not retry time; clamps future time', async () => {
  const past = now - 86400000;
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, providerTimestamp: past / 1000 } }, now);
  expect(saved[0].created_at).toBe(new Date(past).toISOString());
  saved = [];
  await handleWhatsAppAppEcho({ ...event(), timestamp: now + 60000 }, now);
  expect(saved[0].created_at).toBe(new Date(now).toISOString());
});

it.each([undefined, 'not-a-date', 0])('never substitutes receipt time for missing/invalid timestamp %p', async timestamp => {
  await handleWhatsAppAppEcho({ ...event(), timestamp }, now);
  expect(saved).toHaveLength(0);
});

it('stores media placeholders without downloading untrusted URLs', async () => {
  await handleWhatsAppAppEcho({ ...event(), data: { ...event().data, text: '', messageType: 'audio' } }, now);
  expect(saved[0].content).toBe('[audio]');
});

it.each(['lookup', 'insert'])('propagates %s failures for durable webhook retry', async kind => {
  failLookup = kind === 'lookup'; failInsert = kind === 'insert';
  await expect(handleWhatsAppAppEcho(event(), now)).rejects.toThrow('ZAVU_APP_ECHO_');
});