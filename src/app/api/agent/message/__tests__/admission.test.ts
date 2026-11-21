import { createHmac, randomBytes } from 'node:crypto';
import { POST as admit } from '../route';
import { POST as callback } from '@/app/api/integrations/zavu/webhook/route';
import { inboundDatabase, OWNER, SITE } from '@/lib/services/zavu/__tests__/inbound-lead-test-database';

const mockFrom = jest.fn(), mockClaim = jest.fn(), mockFinish = jest.fn(), mockSupport = jest.fn(), mockRead = jest.fn();
let mockDb: ReturnType<typeof inboundDatabase>;
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: {
  from: (...args: unknown[]) => mockFrom(...args), schema: () => ({from: mockFrom}),
} }));
jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: jest.fn(),
  claimZavuInboundWebhook: (...args: unknown[]) => mockClaim(...args),
  finishProviderWebhookEvent: (...args: unknown[]) => mockFinish(...args),
}));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {
  getInstance: () => ({ customerSupportMessage: mockSupport, getFinishedWorkflowResult: mockRead }),
} }));
jest.mock('@/lib/security/upstash-rest', () => ({ sha256: jest.requireActual('@/lib/security/upstash-rest').sha256, setCachedJson: jest.fn() }));
jest.mock('@/lib/services/zavu/inbound-message-license', () => ({ admitZavuInboundAutomation: jest.fn(async () => true) }));
jest.mock('@/lib/services/zavu/inbound-message-history', () => ({ persistDeniedZavuInbound: jest.fn() }));
jest.mock('@/lib/services/zavu/inbound-audio-media', () => ({ resolveInboundAudioMedia: async () => ({ attachments: [] }) }));
jest.mock('@/lib/services/zavu/invitation-finalization', () => ({}));
jest.mock('@/lib/services/zavu/domain-status', () => ({}));
jest.mock('@/lib/services/zavu/voice-webhook-handler', () => ({}));
jest.mock('@/lib/services/zavu/whatsapp-app-echo', () => ({}));
jest.mock('@/lib/services/zavu/template-delivery-events', () => ({}));
jest.mock('@/lib/services/zavu/audio-delivery-events', () => ({}));

const secret = randomBytes(32).toString('hex');
const oldSecret = process.env.ZAVUDEV_WEBHOOK_SECRET;
const envelope = { id: 'event-1', type: 'message.inbound', senderId: 'sender-a',
  site_id: 'not-the-owner', agentId: 'not-an-assignment', userId: 'untrusted',
  data: { text: 'Hello', channel: 'telegram', from: 'telegram:contact', messageId: 'provider-message' } };
const incoming = (payload: unknown = envelope, path = '/api/agent/message') => {
  const raw = JSON.stringify(payload), t = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return new Request(`https://api.example.test${path}`, { method: 'POST', body: raw,
    headers: { 'x-zavu-signature': `t=${t},v2=${digest}` } });
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ZAVUDEV_WEBHOOK_SECRET = secret;
  const connections = ['a', 'b'].map(id => ({ id, zavu_sender_id: `sender-${id}`, type: 'telegram' }));
  connections.push({ id: 'mail', zavu_sender_id: 'sender-a', type: 'email' },
    { id: 'number', zavu_sender_id: 'sender-a', type: 'whatsapp' });
  mockDb = inboundDatabase(mockFrom, { settings: [{ site_id: SITE, channels: { connections } }] });
  mockClaim.mockResolvedValue({ state: 'claimed', token: 'lease' });
  mockFinish.mockResolvedValue(true);
  mockRead.mockReset().mockResolvedValue({success:false});
  mockSupport.mockReset().mockImplementation(async (args, options) => {
    const c = args.custom_data.connection_id, conv = `thread-${c}`, org = args.origin_message_id;
    const shared = { conversation_id:conv, 'conversations.site_id':SITE, conversations:{ site_id:SITE,channel:args.origin } };
    mockDb.tables.messages.push({ ...shared, id:`in-${c}`,role:'user',custom_data:{ ...args.custom_data, origin_message_id:org } },
      { ...shared,id:`draft-${c}`,role:'assistant',content:'Draft',custom_data:{ status:'pending',connection_id:c,origin_message_id:org,reply_to_message_id:`in-${c}` } });
    return {success:true,workflowId:options.workflowId,status:'completed',data:{success:true,data:{require_approval:true}}};
  });
});
afterAll(() => {
  if (oldSecret === undefined) delete process.env.ZAVUDEV_WEBHOOK_SECRET;
  else process.env.ZAVUDEV_WEBHOOK_SECRET = oldSecret;
});

test('callback and neutral URL share one receipt and one scoped execution', async () => {
  const first = await callback(incoming(envelope, '/api/integrations/zavu/webhook'));
  expect([first.status, await first.text()]).toEqual([200, 'OK']);
  mockClaim.mockResolvedValueOnce({ state: 'completed' });
  expect(await (await admit(incoming())).json()).toEqual({ success: true, duplicate: true });
  expect(mockClaim.mock.calls).toEqual(Array(2).fill([{ provider: 'zavu', eventId: 'event-1',
    fallbackMessageId: null, bindingHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]));
  expect(mockSupport).toHaveBeenCalledTimes(1);
  const [args, options] = mockSupport.mock.calls[0];
  expect(args).toMatchObject({ message: 'Hello', userId: OWNER, site_id: SITE, origin: 'telegram',
    origin_message_id: 'provider-message', channel_delivery: true, website_chat_origin: false,
    custom_data: { connection_id: 'a', zavu_sender_id: 'sender-a', zavu_from: 'telegram:contact' } });
  expect(args).not.toHaveProperty('agentId');
  expect(options).toMatchObject({ async: false, taskQueue: 'high' });
});

test('outer workflow success with an exhausted send fails its claim; replay only reads the original', async () => {
  mockSupport.mockResolvedValueOnce({success:true,status:'completed',data:{success:true,data:{processed:true,channelMessageSent:false}}});
  const first = await admit(incoming());
  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({success:false,reconciliation_required:true,state:'unknown'});
  expect(mockFinish).toHaveBeenLastCalledWith('zavu','event-1','lease','failed',expect.stringContaining('Channel reconciliation'));
  mockClaim.mockResolvedValueOnce({state:'claimed',token:'read-lease',reconcileOnly:true});
  expect((await callback(incoming())).status).toBe(202);
  expect(mockRead).toHaveBeenCalledWith(mockSupport.mock.calls[0][1].workflowId);
  expect(mockSupport).toHaveBeenCalledTimes(1);
  expect((await admit(incoming({...envelope,id:'event-2',senderId:'sender-b'}))).status).toBe(200);
  expect(mockSupport.mock.calls[0][1].workflowId).not.toBe(mockSupport.mock.calls[1][1].workflowId);
});

test('cannot acknowledge custody if the durable failed mark loses its lease',async()=>{
  mockSupport.mockRejectedValueOnce(new Error('Temporal result lost'));
  mockFinish.mockResolvedValueOnce(false);
  expect((await admit(incoming())).status).toBe(503);
  expect(mockFinish).not.toHaveBeenCalledWith('zavu','event-1','lease','completed');
});

test('older numeric contact and missing provider message ID retain the signed callback receipt as identity', async () => {
  const event = { senderId: 'sender-a', data: { channel: 'telegram', from: 12345, text: 'Hello' } };
  expect((await admit(incoming(event))).status).toBe(200);
  const receipt = mockClaim.mock.calls[0][0].eventId;
  expect(receipt).toMatch(/^[a-f0-9]{64}$/);
  expect(mockSupport.mock.calls[0][0]).toMatchObject({ phone: '12345', origin_message_id: receipt });
});

test.each([
  ['email', 'email:person@example.test', 'mail', 'email', 'person@example.test'],
  ['whatsapp', 'whatsapp:+15555550100', 'number', 'phone', '+15555550100'],
])('keeps the verified %s destination distinct on a shared provider sender', async (channel, from, connection, field, contact) => {
  expect((await admit(incoming({ ...envelope, data: { ...envelope.data, channel, from } }))).status).toBe(200);
  expect(mockSupport).toHaveBeenCalledTimes(1);
  expect(mockSupport.mock.calls[0][0]).toMatchObject({ origin: channel, [field]: contact,
    channel_delivery: true, custom_data: { connection_id: connection, channel, zavu_from: from, zavu_sender_id: 'sender-a' } });
});

test('denies forged principals, malformed and oversized bodies, and non-message events before claiming', async () => {
  const unsigned = incoming();
  unsigned.headers.delete('x-zavu-signature');
  unsigned.headers.set('x-api-key-data', '{"isService":true}');
  expect((await admit(unsigned)).status).toBe(401);
  const changed = new Request(incoming().url, { method: 'POST', headers: incoming().headers,
    body: JSON.stringify({ ...envelope, senderId: 'sender-b' }) });
  expect((await admit(changed)).status).toBe(401);
  expect((await admit(incoming({ ...envelope, type: 'message.sent' }))).status).toBe(400);
  expect((await admit(incoming('x'.repeat(1024 * 1024)))).status).toBe(413);
  const invalid = new Request(incoming().url, { method: 'POST', body: '{', headers: incoming().headers });
  expect((await admit(invalid)).status).toBe(400);
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockSupport).not.toHaveBeenCalled();
});

test('busy receipt is retryable; no second workflow or receipt finalization', async () => {
  mockClaim.mockResolvedValueOnce({ state: 'busy' });
  const response = await admit(incoming());
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(mockSupport).not.toHaveBeenCalled();
  expect(mockFinish).not.toHaveBeenCalled();
});