import { randomUUID } from 'node:crypto';
import { pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { POST } from '@/app/api/agents/tools/sendChannelMessage/route';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { tryPrepareLongReplyAudio } from '../long-reply-audio';
import { ChannelSendService } from '../ChannelSendService';
import { inboundDatabase, SITE, OTHER_SITE } from '../../zavu/__tests__/inbound-lead-test-database';

const mockFrom = jest.fn(), mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  from: (...args: unknown[]) => mockFrom(...args), schema: () => ({ from: mockFrom }), rpc: (...args: unknown[]) => mockRpc(...args),
} }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/integrations/outstand/client', () => ({ getOutstandClient: jest.fn() }));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({}));
jest.mock('@/lib/integrations/outstand/inbox-sync', () => ({}));
jest.mock('@/lib/services/social-comments/delivery', () => ({}));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({}));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn(async () => true) }));
jest.mock('../explicit-audio-delivery', () => ({}));
jest.mock('@/lib/services/whatsapp/zavu-template-delivery', () => ({ TemplateDeliveryError: class extends Error {} }));
jest.mock('../long-reply-audio', () => ({ tryPrepareLongReplyAudio: jest.fn() }));

const contact = '+15555550100';
const input = { site_id: SITE, channel: 'whatsapp', to: contact, message: 'Saved reply', conversation_id: 'thread', message_id: 'assistant-b' };
const post = (extra: object = {}) => POST(new Request('https://api.example.test/api/agents/tools/sendChannelMessage', {
  method: 'POST', body: JSON.stringify({ ...input, ...extra }),
}) as any);

function fixture(channel = 'whatsapp') {
  const connections = ['a', 'b'].map(id => ({ id, type: channel, status: 'connected', enabled: true,
    license_suspended: false, zavu_sender_id: `sender-${id}` }));
  const rows = connections.flatMap(({ id, zavu_sender_id }) => [
    { id: `in-${id}`, conversation_id: 'thread', role: 'user', 'conversations.site_id': SITE, custom_data: {
      source: 'zavu_inbound_message', channel, connection_id: id, origin_message_id: 'shared-provider-id',
      zavu_sender_id, zavu_from: `${channel}:${contact}` } },
    { id: `assistant-${id}`, conversation_id: 'thread', content: input.message, role: 'assistant', 'conversations.site_id': SITE, custom_data: {
      connection_id: id, origin_message_id: 'shared-provider-id', reply_to_message_id: `in-${id}`, response_format: 'text' } },
  ]);
  const db = inboundDatabase(mockFrom, { messages: rows, conversations: [{ id: 'thread', site_id: SITE, channel }] });
  mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: { effective_plan: 'engine',
    social_media: [], channels: { connections } }, error: null }) }));
  return { db, connections };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(tryPrepareLongReplyAudio).mockResolvedValue(null);
  jest.mocked(sendChannelMessage).mockResolvedValue({ message: { id: 'provider-reply', status: 'queued' } });
});

test.each(['whatsapp', 'telegram', 'instagram', 'email'])('%s uses the saved turn, not array order or a supplied sender', async channel => {
  const { db } = fixture(channel);
  for (const id of ['b', 'a']) {
    const message_id = `assistant-${id}`;
    const response = await post({ channel, message_id, senderId: 'not-authoritative',
      ...(id === 'b' ? { custom_data: { source: 'zavu_inbound_message', channel,
        connection_id: id, zavu_sender_id: `sender-${id}`, zavu_from: `${channel}:${contact}`, origin_message_id: 'shared-provider-id' } } : {}) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: false, status: 'queued', success: true });
    expect(db.tables.messages.find(row => row.id === message_id)?.custom_data).toMatchObject({
      status: 'queued', provider_message_id: 'provider-reply', connection_id: id, reply_to_message_id: `in-${id}`,
    });
    expect(sendChannelMessage).toHaveBeenLastCalledWith(expect.objectContaining({ senderId: `sender-${id}`,
      channel, to: contact, text: input.message, idempotencyKey: `channel-reply:${SITE}:${message_id}` }));
  }
  expect(sendChannelMessage).toHaveBeenCalledTimes(2);
  expect(getOutstandClient).not.toHaveBeenCalled();
});

test.each(['removed', 'disabled', 'replaced', 'duplicate', 'wrong-role', 'foreign-inbound', 'other-thread',
  'wrong-event', 'pending', 'wrong-recipient', 'wrong-channel', 'wrong-content', 'other-site', 'no-saved-reply'])('%s cannot send via account A or another transport', async reason => {
  const { db, connections } = fixture();
  const inbound = db.tables.messages[2], reply = db.tables.messages[3];
  let extra: object = {};
  switch (reason) {
    case 'removed': connections.pop(); break;
    case 'disabled': connections[1].enabled = false; break;
    case 'replaced': connections[1].zavu_sender_id = 'replacement'; break;
    case 'duplicate': connections.push({ ...connections[1], enabled: false }); break;
    case 'wrong-role': inbound.role = 'assistant'; break;
    case 'foreign-inbound': inbound['conversations.site_id'] = OTHER_SITE; break;
    case 'other-thread': inbound.conversation_id = 'another'; break;
    case 'wrong-event': inbound.custom_data.origin_message_id = 'another-event'; break;
    case 'pending': reply.custom_data.status = 'pending'; break;
    case 'wrong-recipient': extra = { to: 'other' }; break;
    case 'wrong-channel': extra = { channel: 'instagram' }; break;
    case 'wrong-content': extra = { message: 'Replacement reply' }; break;
    case 'other-site': extra = { site_id: OTHER_SITE }; break;
    case 'no-saved-reply': extra = { message_id: undefined, custom_data: { source: 'zavu_inbound_message' } }; break;
  }
  const response = await post(extra);
  expect(response.ok).toBe(false);
  expect(sendChannelMessage).not.toHaveBeenCalled();
  expect(getOutstandClient).not.toHaveBeenCalled();
});

test('rechecks the specific licensed sender even after preparation', async () => {
  const { connections } = fixture();
  jest.mocked(tryPrepareLongReplyAudio).mockImplementationOnce(async () => { connections[1].enabled = false; return null; });
  expect((await ChannelSendService.sendMessage(input)).success).toBe(false);
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('a saved reply that changes during preparation cannot be sent using the previous binding', async () => {
  const { db } = fixture();
  jest.mocked(tryPrepareLongReplyAudio).mockImplementationOnce(async () => {
    Object.assign(db.tables.messages[3].custom_data, { connection_id: 'a', reply_to_message_id: 'in-a' });
    return null;
  });
  expect(await ChannelSendService.sendMessage(input)).toMatchObject({ success: false, status: 409 });
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('an unconfirmed provider result cannot produce a sent receipt', async () => {
  const { db } = fixture();
  jest.mocked(sendChannelMessage).mockResolvedValueOnce({ message: { id: 'not-accepted', status: 'failed' } });
  expect((await post()).ok).toBe(false);
  expect(db.tables.messages[3].custom_data).toMatchObject({ provider_message_id: 'not-accepted', status: 'failed', pinned_text_delivery: { state: 'failed' } });
});

test.each([{ connection_id: 'a' }, { zavu_sender_id: 'sender-a' }, { origin_message_id: 'different' },
  { zavu_from: 'different-contact' }, { channel: 'email' }])('rejects a mismatched worker turn even when the reply ID is valid: %j', async mismatch => {
  fixture();
  const response = await post({ custom_data: { source: 'zavu_inbound_message', channel: 'whatsapp',
    connection_id: 'b', zavu_sender_id: 'sender-b', zavu_from: `whatsapp:${contact}`, ...mismatch } });
  expect(response.status).toBe(409);
  expect(sendChannelMessage).not.toHaveBeenCalled();
});
// A replay may inspect an exact saved attempt; it must not place another send.
function markAttempt(db: ReturnType<typeof fixture>['db'], state: string, delivery: string) {
  const row = db.tables.messages[3];
  Object.assign(row.custom_data, { status: delivery,
    ...(state === 'accepted' ? { provider_message_id: 'provider-reply' } : {}),
    pinned_text_delivery: { id: randomUUID(), payload_hash: pinnedReplyPayloadHash(input.message, row.custom_data), state,
      ...(state === 'accepted' ? {provider_message_id: 'provider-reply'} : {}), provider: 'zavu', site_id: SITE, channel: 'whatsapp',
      conversation_id: 'thread', message_id: 'assistant-b', zavu_from: `whatsapp:${contact}`,
      recipient: contact, connection_id: 'b', sender_id: 'sender-b', inbound_message_id: 'in-b', origin_message_id: 'shared-provider-id' },
  });
  return row;
}

test.each(['queued', 'sending', 'sent', 'delivered', 'read'])('an accepted %s receipt is read back without a second provider request', async status => {
  const { db } = fixture(); const row = markAttempt(db, 'accepted', status);
  const response = await post();
  expect(await response.json()).toMatchObject({ success: true, status, delivered: ['delivered', 'read'].includes(status) });
  expect(row.custom_data.status).toBe(status);
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('ambiguous provider acceptance leaves a durable attempt; retry cannot send or prepare audio again', async () => {
  const { db } = fixture();
  jest.mocked(sendChannelMessage).mockRejectedValueOnce(new Error('Lost acknowledgement'));
  expect((await post()).ok).toBe(false);
  const record = db.tables.messages[3].custom_data;
  expect(record).toMatchObject({ status: 'reconciliation_required', pinned_text_delivery: { state: 'attempting',
    site_id: SITE, recipient: contact, connection_id: 'b', sender_id: 'sender-b', origin_message_id: 'shared-provider-id', inbound_message_id: 'in-b' } });
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: { channel_reply_attempt: record.pinned_text_delivery.id } }));
  expect((await post()).ok).toBe(false);
  expect(sendChannelMessage).toHaveBeenCalledTimes(1);
  expect(tryPrepareLongReplyAudio).toHaveBeenCalledTimes(1);
});

test('an in-flight read receipt with the same provider ID wins over a queued HTTP response', async () => {
  const { db } = fixture();
  jest.mocked(sendChannelMessage).mockImplementationOnce(async () => {
    Object.assign(db.tables.messages[3].custom_data, { status: 'read', provider_message_id: 'provider-reply' });
    return { message: { id: 'provider-reply', status: 'queued' } };
  });
  expect(await (await post()).json()).toMatchObject({ success: true, status: 'read', delivered: true });
  expect(db.tables.messages[3].custom_data.status).toBe('read');
});

test('conflicting provider identity cannot be replaced or acknowledged', async () => {
  const { db } = fixture();
  jest.mocked(sendChannelMessage).mockImplementationOnce(async () => {
    Object.assign(db.tables.messages[3].custom_data, { provider_message_id: 'other-id', status: 'read' });
    Object.assign(db.tables.messages[3].custom_data.pinned_text_delivery, { provider_message_id: 'other-id', state: 'accepted' });
    return { message: { id: 'provider-reply', status: 'queued' } };
  });
  expect((await post()).ok).toBe(false);
  expect(db.tables.messages[3].custom_data).toMatchObject({ provider_message_id: 'other-id', status: 'read',
    pinned_text_delivery: {state:'conflict', conflicting_provider_message_id:'provider-reply'} });
  expect((await post()).ok).toBe(false);
  expect(sendChannelMessage).toHaveBeenCalledTimes(1);
});

test('a read receipt predating sticky claims is never resent or downgraded', async () => {
  const { db } = fixture(); Object.assign(db.tables.messages[3].custom_data, { status: 'read', provider_message_id: 'provider-reply' });
  const response = await post();
  expect(response.status).toBe(409); // No durable binding on a pre-v2 receipt: inspect, never send again.
  expect(db.tables.messages[3].custom_data.status).toBe('read');
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('a human pause after an ambiguous send cannot relabel the attempt as suppressed', async () => {
  const { db } = fixture(); const row = markAttempt(db, 'attempting', 'reconciliation_required');
  db.tables.conversations[0].automation_paused_until = '2999-01-01T00:00:00Z';
  expect((await post()).status).toBe(409);
  expect(row.custom_data.status).toBe('reconciliation_required');
  expect(row.custom_data.automation_skipped).toBeUndefined();
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('the owner can suppress a claimed but not dispatched turn after a fresh human pause', async () => {
  const { db } = fixture();
  jest.mocked(tryPrepareLongReplyAudio).mockImplementationOnce(async () => {
    db.tables.conversations[0].automation_paused_until = '2999-01-01T00:00:00Z'; return null;
  });
  expect(await (await post()).json()).toMatchObject({ skipped: true, delivered: false });
  expect(db.tables.messages[3].custom_data).toMatchObject({ status: 'skipped', pinned_text_delivery: { state: 'skipped' } });
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('simultaneous calls claim once before preparation or dispatch', async () => {
  fixture(); const results = await Promise.all([post(), post()]);
  expect(results.some(r => r.ok)).toBe(true);
  expect(sendChannelMessage).toHaveBeenCalledTimes(1);
  expect(tryPrepareLongReplyAudio).toHaveBeenCalledTimes(1);
});
