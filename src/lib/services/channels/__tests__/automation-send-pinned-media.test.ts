import { POST } from '@/app/api/agents/tools/sendChannelMessage/route';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { canAccessSite } from '@/lib/security/site-access';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { inboundDatabase, SITE, OTHER_SITE } from '../../zavu/__tests__/inbound-lead-test-database';
import { tryPrepareLongReplyAudio } from '../long-reply-audio';

const mockFrom = jest.fn(), mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  from: (...args: unknown[]) => mockFrom(...args), schema: () => ({ from: mockFrom }), rpc: (...args: unknown[]) => mockRpc(...args),
} }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => {}) }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/integrations/outstand/client', () => ({ getOutstandClient: jest.fn() }));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({}));
jest.mock('@/lib/integrations/outstand/inbox-sync', () => ({}));
jest.mock('@/lib/services/social-comments/delivery', () => ({}));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({}));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: { checkResponseWindow: jest.fn() } }));
jest.mock('@/lib/services/whatsapp/zavu-template-delivery', () => ({ TemplateDeliveryError: class extends Error {} }));
jest.mock('../explicit-audio-delivery', () => ({}));
jest.mock('../long-reply-audio', () => ({ tryPrepareLongReplyAudio: jest.fn() }));

const file = { message_type: 'image', media_url: 'https://assets.example.test/file.jpg', mime_type: 'image/jpeg' };
const contact = '+15555550100';
const saved = { site_id: SITE, conversation_id: 'thread', message_id: 'reply', message: 'A saved caption', channel: 'telegram', to: contact, ...file };
const post = (extra: object = {}) => POST(new Request('https://api.example.test/api/agents/tools/sendChannelMessage', {
  method: 'POST', body: JSON.stringify({ ...saved, ...extra }),
}) as any);
const provider = jest.mocked(sendChannelMessage);

function fixture(channel = 'telegram') {
  const connections = ['a', 'b'].map(id => ({ id, type: channel, zavu_sender_id: `sender-${id}`,
    status: 'connected', enabled: true, license_suspended: false }));
  const inbounds = connections.map(({ id, zavu_sender_id }) => ({ id: `in-${id}`, role: 'user', conversation_id: 'thread',
    'conversations.site_id': SITE, custom_data: { source: 'zavu_inbound_message', channel, connection_id: id, zavu_sender_id,
      zavu_from: `${channel}:${contact}`, origin_message_id: 'event-on-both-accounts' } }));
  const db = inboundDatabase(mockFrom, {
    conversations: [{ id: 'thread', channel, site_id: SITE, custom_data: {} }],
    messages: [...inbounds, { id: 'reply', role: 'assistant', content: saved.message, conversation_id: 'thread',
      'conversations.site_id': SITE, conversations: { channel, site_id: SITE }, custom_data: { ...file,
        connection_id: 'b', reply_to_message_id: 'in-b', origin_message_id: 'event-on-both-accounts', response_format: 'text' } }],
  });
  const reply = db.tables.messages[2], inbound = db.tables.messages[1], conversation = db.tables.conversations[0];
  let projection = 0;
  const onProjection = (cb: (number: number) => void) => mockRpc.mockImplementation(() => ({ abortSignal: async () => {
    cb(++projection);
    return { data: { effective_plan: 'engine', channels: { connections }, social_media: [] }, error: null };
  } }));
  onProjection(() => {});
  return { db, reply, inbound, conversation, connections, onProjection };
}

function recordEvent(row: Record<string, any>, status = 'read', id = 'provider-id') {
  Object.assign(row.custom_data.native_media_delivery, { state: status === 'failed' ? 'failed' : 'accepted', provider_message_id: id });
  Object.assign(row.custom_data, { status, provider_message_id: id });
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValue({ withinWindow: true });
  provider.mockResolvedValue({ message: { id: 'provider-id', status: 'queued' } });
});
afterEach(() => {
  expect(getOutstandClient).not.toHaveBeenCalled();
  expect(tryPrepareLongReplyAudio).not.toHaveBeenCalled();
});

test.each(['queued', 'sending', 'sent', 'delivered', 'read'])('only %s evidence is saved and returned on send and replay', async status => {
  const { reply } = fixture('instagram');
  const delivered = status === 'delivered' || status === 'read';
  provider.mockImplementationOnce(async request => {
    const attempt = reply.custom_data.native_media_delivery;
    expect(reply.custom_data.status).toBe('reconciliation_required');
    expect(attempt).toMatchObject({ state: 'attempting', id: expect.stringMatching(/^[0-9a-f-]{36}$/), payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider: 'zavu', site_id: SITE, message_id: 'reply', conversation_id: 'thread', inbound_message_id: 'in-b',
      channel: 'instagram', zavu_from: `instagram:${contact}`, recipient: contact, connection_id: 'b', sender_id: 'sender-b', origin_message_id: 'event-on-both-accounts' });
    expect(request).toMatchObject({ senderId: 'sender-b', to: contact, channel: 'instagram', messageType: 'image',
      metadata: { channel_reply_attempt: attempt.id }, idempotencyKey: `channel-reply:${SITE}:reply`, content: { mediaUrl: file.media_url, mimeType: file.mime_type } });
    return { message: { id: 'provider-id', status } };
  });
  for (let i = 0; i < 2; i++) {
    const response = await post({ channel: 'instagram' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, accepted: true, delivered, status, messageId: 'provider-id' });
    expect(reply.custom_data).toMatchObject({ ...file, status, provider_message_id: 'provider-id', native_media_delivery: { state: 'accepted', provider_message_id: 'provider-id' } });
  }
  expect(provider).toHaveBeenCalledTimes(1);
});

test.each([['preflight', 2], ['after claim', 3]] as const)('a B-to-A relink %s cannot dispatch on B or A, even without a worker hint', async (_label, when) => {
  const { reply, onProjection } = fixture();
  onProjection(n => { if (n === when) Object.assign(reply.custom_data, { connection_id: 'a', reply_to_message_id: 'in-a' }); });
  expect((await post()).status).toBe(409);
  if (when === 2) expect(reply.custom_data.native_media_delivery).toBeUndefined();
  else {
    expect(reply.custom_data.native_media_delivery).toMatchObject({ state: 'attempting', connection_id: 'b', inbound_message_id: 'in-b' });
    expect((await post()).ok).toBe(false);
  }
  expect(provider).not.toHaveBeenCalled();
});

test.each(['inbound row', 'from namespace', 'sender', 'same sender on second row', 'connection disabled', 'site', 'inbound site',
  'saved content', 'attachment', 'mime type', 'attempt hash', 'attempt id', 'attempt sender', 'attempt recipient',
  'attempt state', 'another receipt', 'approval', 'human role', 'legacy channel conflict'])('an altered %s after the durable claim cannot dispatch', async change => {
  const { db, reply, inbound, connections, onProjection, conversation } = fixture();
  onProjection(n => {
    if (n !== 3) return;
    const data = reply.custom_data, attempt = data.native_media_delivery;
    switch (change) {
      case 'inbound row': db.tables.messages.push({ ...inbound, id: 'other-inbound' }); data.reply_to_message_id = 'other-inbound'; break;
      case 'from namespace': inbound.custom_data.zavu_from = contact; break; // same normalized recipient
      case 'sender': connections[1].zavu_sender_id = 'new'; break;
      case 'same sender on second row': connections[0].zavu_sender_id = 'sender-b'; break;
      case 'connection disabled': connections[1].enabled = false; break;
      case 'site': conversation.site_id = OTHER_SITE; break;
      case 'inbound site': inbound['conversations.site_id'] = OTHER_SITE; break;
      case 'saved content': reply.content = 'A different caption'; break;
      case 'attachment': data.media_url = 'https://assets.example.test/new.jpg'; break;
      case 'mime type': data.mime_type = 'image/png'; break;
      case 'attempt hash': attempt.payload_hash = 'different'; break;
      case 'attempt id': attempt.id = 'new'; break;
      case 'attempt sender': attempt.sender_id = 'new'; break;
      case 'attempt recipient': attempt.recipient = 'new'; break;
      case 'attempt state': attempt.state = 'failed'; break;
      case 'another receipt': data.provider_message_id = 'unknown-receipt'; break;
      case 'approval': data.status = 'pending'; break;
      case 'human role': reply.role = 'team_member'; break;
      case 'legacy channel conflict': conversation.custom_data.channel = 'whatsapp'; break;
    }
  });
  expect((await post()).ok).toBe(false);
  expect(reply.custom_data.native_media_delivery).toBeDefined();
  expect(provider).not.toHaveBeenCalled();
});

test('a metadata-only WhatsApp channel works only for an exact saved site, thread, turn and file', async () => {
  const { conversation, inbound, reply } = fixture('whatsapp');
  conversation.channel = null; conversation.custom_data.channel = 'whatsapp';
  expect((await post({ channel: 'whatsapp', site_id: OTHER_SITE })).ok).toBe(false);
  inbound['conversations.site_id'] = OTHER_SITE;
  expect((await post({ channel: 'whatsapp' })).ok).toBe(false);
  inbound['conversations.site_id'] = SITE; inbound.conversation_id = 'elsewhere';
  expect((await post({ channel: 'whatsapp' })).ok).toBe(false);
  inbound.conversation_id = 'thread'; reply.custom_data.origin_message_id = 'another-event';
  expect((await post({ channel: 'whatsapp' })).ok).toBe(false);
  reply.custom_data.origin_message_id = 'event-on-both-accounts';
  expect((await post({ channel: 'whatsapp', message: 'Different caption' })).ok).toBe(false);
  expect(provider).not.toHaveBeenCalled();
  const response = await post({ channel: 'whatsapp', conversation_id: undefined });
  expect(await response.json()).toMatchObject({ success: true, accepted: true, status: 'queued', delivered: false });
  expect(WhatsAppTemplateService.checkResponseWindow).toHaveBeenLastCalledWith('thread', contact, SITE);
  expect(provider).toHaveBeenCalledTimes(1);
});

test.each(['authorization', 'awaiting approval', 'ambiguous channel', 'channel absent', 'window closed', 'window closes after claim'])('%s cannot cause a provider call', async label => {
  const { conversation, reply } = fixture('whatsapp');
  switch (label) {
    case 'authorization': jest.mocked(canAccessSite).mockResolvedValueOnce(false); break;
    case 'awaiting approval': reply.custom_data.status = 'pending'; break;
    case 'ambiguous channel': conversation.custom_data.channel = 'telegram'; break;
    case 'channel absent': conversation.channel = null; break;
    case 'window closed': jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValue({ withinWindow: false }); break;
    case 'window closes after claim': jest.mocked(WhatsAppTemplateService.checkResponseWindow)
      .mockResolvedValueOnce({ withinWindow: true }).mockResolvedValue({ withinWindow: false }); break;
  }
  expect((await post({ channel: 'whatsapp' })).ok).toBe(false);
  if (label === 'window closes after claim') expect(reply.custom_data.native_media_delivery.state).toBe('attempting');
  else expect(reply.custom_data.native_media_delivery).toBeUndefined();
  expect(provider).not.toHaveBeenCalled();
});

test('pause immediately after the claim can suppress only this known, not-yet-dispatched attempt', async () => {
  const { onProjection, conversation, reply } = fixture();
  onProjection(n => { if (n === 3) conversation.automation_paused_until = '2999-01-01T00:00:00Z'; });
  const response = await post();
  expect(await response.json()).toMatchObject({ success: true, status: 'skipped', skipped: true, delivered: false });
  expect(reply.custom_data).toMatchObject({ status: 'skipped', automation_skipped: true, native_media_delivery: { state: 'skipped' } });
  expect(provider).not.toHaveBeenCalled();
});

test.each(['timeout', 'no id', 'no status', 'placeholder', 'unknown state', 'success false', 'persistence outage', 'failed'])('%s never triggers a retry, alternate sender or false positive receipt', async outcome => {
  const { db, reply, conversation } = fixture();
  provider.mockImplementationOnce(async () => {
    switch (outcome) {
      case 'timeout': throw new Error('Outcome unknown');
      case 'no id': return { message: { status: 'sent' } };
      case 'no status': return { message: { id: 'provider-id' } };
      case 'placeholder': return { message: { id: 'unknown', status: 'queued' } };
      case 'unknown state': return { message: { id: 'provider-id', status: 'processed' } };
      case 'success false': return { success: false, message: { id: 'provider-id', status: 'sent' } };
      case 'failed': return { message: { id: 'provider-id', status: 'failed' } };
      default: db.failNextTable = 'messages'; db.failNextKind = 'update'; return { message: { id: 'provider-id', status: 'queued' } };
    }
  });
  expect((await post()).ok).toBe(false);
  if (outcome === 'failed') expect(reply.custom_data).toMatchObject({ status: 'failed', provider_message_id: 'provider-id', native_media_delivery: { state: 'failed' } });
  else {
    expect(reply.custom_data).toMatchObject({ status: 'reconciliation_required', native_media_delivery: { state: 'attempting' } });
    expect(reply.custom_data.provider_message_id).toBeUndefined();
  }
  // Neither a late pause nor an old repair job resetting the queue can undo the claim.
  conversation.automation_paused_until = '2999-01-01T00:00:00Z';
  expect((await post()).ok).toBe(false);
  expect(reply.custom_data.automation_skipped).not.toBe(true);
  delete conversation.automation_paused_until; reply.custom_data.status = 'accepted';
  expect((await post()).ok).toBe(false);
  expect(provider).toHaveBeenCalledTimes(1);
});

test.each(['before response', 'during receipt CAS', 'response lost', 'different provider ID', 'failed callback'])('%s preserves authoritative receipt evidence and never issues another POST', async timing => {
  const { db, reply } = fixture();
  provider.mockImplementationOnce(async () => {
    if (timing === 'during receipt CAS') db.beforeUpdate = () => { db.beforeUpdate = undefined; recordEvent(reply); };
    else recordEvent(reply, timing === 'failed callback' ? 'failed' : 'read');
    if (timing === 'response lost') throw new Error('Lost response');
    return { message: { id: timing === 'different provider ID' ? 'another-provider-id' : 'provider-id', status: 'queued' } };
  });
  const response = await post();
  if (timing === 'different provider ID' || timing === 'failed callback') expect(response.ok).toBe(false);
  else expect(await response.json()).toMatchObject({ success: true, accepted: true, status: 'read', messageId: 'provider-id', delivered: true });
  expect(reply.custom_data).toMatchObject({ provider_message_id: 'provider-id', status: timing === 'failed callback' ? 'failed' : 'read' });
  expect(provider).toHaveBeenCalledTimes(1);
});

test('concurrent HTTP calls can dispatch the saved file only once', async () => {
  const { reply } = fixture();
  const responses = await Promise.all([post(), post()]);
  expect(responses.some(response => response.ok)).toBe(true);
  expect(reply.custom_data.native_media_delivery.state).toBe('accepted');
  expect(provider).toHaveBeenCalledTimes(1);
});

test.each(['stripped link', 'role changed', 'changed attachment', 'forged sender'])('a durable attempt with %s cannot fall through to a generic transport on replay', async change => {
  const { reply } = fixture('instagram');
  expect((await post({ channel: 'instagram' })).ok).toBe(true);
  let extra = {};
  switch (change) {
    case 'stripped link': delete reply.custom_data.origin_message_id; delete reply.custom_data.reply_to_message_id; break;
    case 'role changed': reply.role = 'team_member'; break;
    case 'changed attachment': reply.custom_data.media_url = 'https://assets.example.test/changed.jpg'; extra = { media_url: reply.custom_data.media_url }; break;
    case 'forged sender': reply.custom_data.native_media_delivery.sender_id = 'sender-a'; break;
  }
  expect((await post({ channel: 'instagram', ...extra })).ok).toBe(false);
  expect(provider).toHaveBeenCalledTimes(1);
});
