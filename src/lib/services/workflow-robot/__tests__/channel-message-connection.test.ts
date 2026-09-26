// @ts-nocheck -- ESM Jest mocks are dynamically imported under the ES5 TS target.
import { jest } from '@jest/globals';

const from = jest.fn();
const materializeRunFromGraph = jest.fn();
const siteId = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const messageId = 'zavu-call-1';
let connections: any[];
let deliveries: any[];
let conversation: any;

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from, schema: jest.fn(() => ({ from })) },
}));
jest.unstable_mockModule('../materialize', () => ({ materializeRunFromGraph }));
const { resolveMessageConnection, prepareChannelMessageRuns } = await import('../channel-message');

const voice = (id: string, sender: string, status = 'connected') => ({
  id, type: 'voice', status, zavu_sender_id: sender,
});
const voiceIdentity = { messageId, conversationId };

beforeEach(() => {
  jest.clearAllMocks();
  connections = [];
  deliveries = [{ site_id: siteId, conversation_id: conversationId,
    zavu_call_id: messageId, zavu_sender_id: 'sender-2' }];
  conversation = { site_id: siteId, channel: 'voice', custom_data: {
    source: 'zavu_inbound_voice', call_direction: 'inbound', provider_call_id: messageId,
  } };
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: any = {};
    q.select = jest.fn(() => q);
    q.eq = jest.fn((key: string, value: unknown) => { filters[key] = value; return q; });
    q.limit = jest.fn(() => q);
    const result = () => {
      if (table === 'settings') return { data: { channels: { connections } }, error: null };
      if (table === 'conversations') return { data: conversation?.site_id === filters.site_id
        && filters.id === conversationId ? conversation : null, error: null };
      if (table === 'voice_call_deliveries') return { data: deliveries.filter((delivery) =>
        delivery.site_id === filters.site_id && delivery.zavu_call_id === filters.zavu_call_id), error: null };
      if (table === 'workflow_triggers') return { data: [{ id: 'trigger-1', instance_id: 'instance-1', site_id: siteId,
        config: { channel: 'sms', connection_id: 'sms-1' } }], error: null };
      throw new Error(`Unexpected table ${table}`);
    };
    q.maybeSingle = jest.fn(async () => result());
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return q;
  });
});

it('never guesses among active same-type connections or trusts a supplied connection ID', async () => {
  connections = [
    { id: 'sms-1', type: 'sms', status: 'connected', zavu_sender_id: 'sender-1' },
    { id: 'sms-2', type: 'sms', status: 'synced', zavu_sender_id: 'sender-2' },
  ];
  expect(await resolveMessageConnection(siteId, 'sms', {
    messageId: 'sms-1', connectionId: 'sms-1', senderId: 'sender-1',
  })).toBeUndefined();
  // A connection-scoped trigger is not materialized for ambiguous identity.
  expect(await prepareChannelMessageRuns({
    siteId, messageId: 'sms-1', channel: 'sms', message: 'Hello',
    connectionId: 'sms-1', senderId: 'sender-1',
  })).toEqual([]);
  expect(materializeRunFromGraph).not.toHaveBeenCalled();
  connections = [
    { id: 'inbox-1', type: 'email', status: 'active', metadata: { inbox_id: 'support@a.test' } },
    { id: 'inbox-2', type: 'email', status: 'synced', metadata: { inbox_id: 'support@b.test' } },
  ];
  expect(await resolveMessageConnection(siteId, 'email', {
    messageId: 'email-1', conversationId, inboxId: 'support@b.test',
  })).toBeUndefined();
});

it('recognizes connected, active, synced, but excludes disconnected and duplicate IDs', async () => {
  connections = [voice('voice-1', 'sender-1', 'active'), voice('voice-2', 'sender-2', 'disabled')];
  expect(await resolveMessageConnection(siteId, 'voice')).toBe('voice-1');
  connections[1].status = 'synced';
  expect(await resolveMessageConnection(siteId, 'voice')).toBeUndefined();
  connections = [voice('voice-1', 'sender-1'), voice('voice-1', 'sender-1')];
  expect(await resolveMessageConnection(siteId, 'voice')).toBeUndefined();
});

it('uses the unique same-site persisted inbound call sender for a trusted match', async () => {
  connections = [voice('voice-1', 'sender-1', 'active'), voice('voice-2', 'sender-2', 'synced')];
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBe('voice-2');
  // Temporal may omit conversationId; the verified inbound delivery supplies it.
  expect(await resolveMessageConnection(siteId, 'voice', { messageId })).toBe('voice-2');
  expect(await resolveMessageConnection(siteId, 'voice', {
    messageId, conversationId: '55555555-5555-4555-8555-555555555555',
  })).toBeUndefined();
});

it('refuses mismatched sender/call/conversation and never falls back to a sole Voice connection', async () => {
  connections = [voice('voice-1', 'sender-1')];
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
  connections.push(voice('voice-2', 'sender-2'));
  expect(await resolveMessageConnection(siteId, 'voice', { messageId: 'wrong-call', conversationId })).toBeUndefined();
  conversation.custom_data.provider_call_id = 'wrong-call';
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
  conversation.custom_data.provider_call_id = messageId;
  conversation.custom_data.call_direction = 'outbound';
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
  conversation.custom_data.call_direction = 'inbound';
  deliveries.push({ ...deliveries[0] });
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
  deliveries.pop();
  connections.push(voice('voice-3', 'sender-2'));
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
});

it('will not use another site’s persisted voice identity', async () => {
  connections = [voice('voice-1', 'sender-1'), voice('voice-2', 'sender-2')];
  deliveries[0].site_id = otherSite;
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
  deliveries[0].site_id = siteId;
  conversation.site_id = otherSite;
  expect(await resolveMessageConnection(siteId, 'voice', voiceIdentity)).toBeUndefined();
});