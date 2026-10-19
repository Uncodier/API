import { randomBytes, randomUUID } from 'node:crypto';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: jest.fn(), schema: jest.fn() } }));
jest.mock('@/lib/timezone/resolveUserTimezone', () => ({ resolveClientTimezone: async () => 'America/Mexico_City' }));
// Stub only the transport boundary; preparation, exact adapter, tracked service,
// consent checks, guidance projection and message state persistence stay real.
jest.mock('@/lib/services/zavu/client', () => ({ zavuFetch: jest.fn(), sendChannelMessage: jest.fn() }));
// Other provider transports are unused in this Voice/SMS suite. Throw if chosen.
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {
  sendEmail: () => { throw new Error('Unexpected SMTP transport'); },
} }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: {
  sendViaAgentMail: () => { throw new Error('Unexpected AgentMail transport'); },
} }));
jest.mock('@/lib/messaging/exact-email-content', () => ({ exactEmailContent: () => { throw new Error('Unexpected email route'); } }));

import { preparePublishTest } from '../test-delivery';
import { supabaseAdmin as exactDb } from '@/lib/database/supabase-client';
import { supabaseAdmin as voiceDb } from '@/lib/database/supabase-server';
import { zavuFetch, sendChannelMessage } from '@/lib/services/zavu/client';
import type { PublishToolParams } from '../assistantProtocol';
import type { DeliveryRoute } from '@/lib/messaging/delivery-routing';
import { voiceTestDatabase } from '../test-support/voice-db';
import { licensedRpcResult } from '@/lib/messaging/__tests__/licensed-rpc-fixture';
import { buildToolExecutionContext } from '@/lib/services/tool-execution-context';
import { loadVoiceExecutionContext } from '@/lib/services/zavu/voice-execution-context';

const siteId = randomUUID(); const leadId = randomUUID();
const routes: DeliveryRoute[] = [{ channel: 'voice', connection_id: 'selected', voice_mode: 'agent_call' }];
let db: ReturnType<typeof voiceTestDatabase>;
let providerFailure: 'failed' | 'unknown' | undefined;
const args = (): PublishToolParams => ({ is_test: true, test_lead_id: leadId,
  objective: 'Ask {{lead.first_name}} about availability', additional_context: 'Private business context for {{site.name}}' });
const prepare = (overrides: Partial<PublishToolParams> = {}, text = 'Hello {{lead.first_name}}', selected = routes) =>
  preparePublishTest(siteId, { ...args(), ...overrides }, text, undefined, selected);
const callRequests = () => (zavuFetch as jest.Mock).mock.calls.filter(([path]) => path === '/calls');

beforeEach(() => {
  jest.clearAllMocks(); providerFailure = undefined;
  db = voiceTestDatabase(siteId, leadId);
  (exactDb.from as jest.Mock).mockImplementation(db.from);
  (exactDb.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => {
    const result = await db.from('settings').select('channels').eq('site_id', siteId).maybeSingle();
    return licensedRpcResult(result.data.channels).abortSignal();
  } }));
  (voiceDb.from as jest.Mock).mockImplementation(db.from);
  (voiceDb.schema as jest.Mock).mockReturnValue({ from: db.from });
  (sendChannelMessage as jest.Mock).mockResolvedValue({ success: true, message: { id: 'sms-provider-id', status: 'queued' } });
  (zavuFetch as jest.Mock).mockImplementation(async (path: string, options?: { method?: string; body?: any }) => {
    if (path.includes('/agent')) return { agent: { id: 'agent', enabled: true, includeContactMetadata: true } };
    if (path.startsWith('/contacts/phone/')) throw Object.assign(new Error('Synthetic not found'), { status: 404 });
    if (path.startsWith('/contacts')) return options?.method === 'POST'
      ? { contact: { id: 'contact' } } : options?.method === 'PATCH' ? {} : { items: [] };
    if (path === '/calls') {
      if (providerFailure) throw Object.assign(new Error('Synthetic provider failure'), { status: providerFailure === 'failed' ? 400 : 503 });
      return { call: { id: 'provider-call', status: 'queued', direction: 'outbound', to: '+15551234567', from: '+15557654321' } };
    }
    throw new Error(`Unexpected transport request: ${path}`);
  });
});

test('real preparation -> exact adapter -> tracked service owns server-created IDs and selected sender, with private guidance', async () => {
  const send = await prepare({ ...({ message_id: 'client-message', conversation_id: 'client-conversation' } as any) });
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled();
  const response = await send();
  expect(response).toMatchObject({ success: true, type: 'single_test_send', result: { callId: 'provider-call' } });
  expect(callRequests()).toHaveLength(1);
  const body = JSON.parse(callRequests()[0][1].body);
  const conversation = db.tables.conversations[0]; const message = db.tables.messages[0];
  expect(conversation).toMatchObject({ site_id: siteId, lead_id: leadId, channel: 'voice' });
  expect(message).toMatchObject({ role: 'assistant', lead_id: leadId, conversation_id: conversation.id, content: '[TEST] Hello Ada' });
  expect(message.id).not.toBe('client-message'); expect(conversation.id).not.toBe('client-conversation');
  for (const row of [conversation, message]) expect(row.custom_data).toMatchObject({
    connection_id: 'selected', channel: 'voice', voice_mode: 'agent_call', source: 'publish_test', is_test: true,
    voice_objective: 'Ask Ada about availability', voice_additional_context: 'Private business context for Test business',
  });
  expect(body).toMatchObject({ senderId: 'selected-sender', greeting: '[TEST] Hello Ada',
    metadata: { messageId: message.id, conversationId: conversation.id, leadId,
      objective: 'Ask Ada about availability', additionalContext: 'Private business context for Test business' } });
  expect(body.greeting).not.toMatch(/availability|Private/);
  expect(message.custom_data).toMatchObject({ status: 'sent', call_status: 'queued', provider_call_id: 'provider-call' });
  expect(db.tables.voice_call_deliveries[0]).toMatchObject({ site_id: siteId, message_id: message.id, conversation_id: conversation.id });
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('Content Creator Send Test retains inherited private purpose through tracking and live context with an outbound introduction', async () => {
  const secret = randomBytes(24).toString('hex');
  const nodeId = randomUUID(); const contentId = randomUUID();
  const context = buildToolExecutionContext({ site_id: siteId,
    intent: 'Follow up with {{lead.first_name}} about availability',
    background: `Supporting context for {{site.name}}. password=${secret}`,
    source: { tool: 'assistant', node_id: nodeId, content_id: contentId } });
  const greeting = 'Hello {{lead.first_name}}, I am Morgan from {{site.name}}. I am calling to follow up; is now a good time?';
  const send = await preparePublishTest(siteId, { is_test: true, test_lead_id: leadId, content_id: contentId }, greeting, undefined, routes, context);
  expect(await send()).toMatchObject({ success: true });
  const message = db.tables.messages[0];
  const body = JSON.parse(callRequests()[0][1].body);
  expect(body.greeting).toBe('[TEST] Hello Ada, I am Morgan from Test business. I am calling to follow up; is now a good time?');
  expect(message.custom_data.tool_execution_context).toMatchObject({
    intent: 'Follow up with Ada about availability', source: { tool: 'publish', node_id: nodeId, content_id: contentId },
  });
  const live = await loadVoiceExecutionContext({ siteId, conversationId: message.conversation_id, messageId: message.id, direction: 'outbound' });
  expect(live.objective).toBe('Follow up with Ada about availability');
  expect(live.additional_context).toContain('Supporting context for Test business');
  expect(live.guidance).toContain('introduce yourself by your configured name and business');
  expect(live.guidance).toContain("Never open with 'How can I help you?'");
  expect(live.source).toMatchObject({ node_id: nodeId, content_id: contentId });
  for (const value of [db.tables.messages, db.tables.conversations, live, body]) expect(JSON.stringify(value)).not.toContain(secret);
  expect(body.greeting).not.toContain('Supporting context');
});

test('Send Test explicit guidance wins and foreign/customer conversation background never propagates to another recipient', async () => {
  const context = buildToolExecutionContext({ site_id: siteId, intent: 'Fallback intent',
    background: 'Another customer private conversation', source: { conversation_id: randomUUID() } });
  const send = await preparePublishTest(siteId, args(), 'Hello', undefined, routes, context);
  expect(await send()).toMatchObject({ success: true });
  expect(db.tables.messages[0].custom_data.tool_execution_context).toMatchObject({
    intent: 'Ask Ada about availability', background: 'Private business context for Test business',
  });
  expect(JSON.stringify(db.tables.messages)).not.toContain('Another customer');

  const foreign = buildToolExecutionContext({ site_id: randomUUID(), intent: 'Foreign tenant intent', background: 'Foreign background' });
  const secondSend = await preparePublishTest(siteId, { is_test: true, test_lead_id: leadId }, 'Hello', undefined,
    [{ channel: 'voice', connection_id: 'first', voice_mode: 'agent_call' }], foreign);
  expect(await secondSend()).toMatchObject({ success: true });
  expect(JSON.stringify(db.tables.messages[1])).not.toMatch(/Foreign tenant|Foreign background/);
});

test('Send Test omits inherited customer conversation background and IDs when no explicit campaign context exists', async () => {
  const conversationId = randomUUID(); const messageId = randomUUID();
  const context = buildToolExecutionContext({ site_id: siteId, intent: 'Ask about availability',
    background: 'Private history for another customer', source: { conversation_id: conversationId, message_id: messageId } });
  const send = await preparePublishTest(siteId, { is_test: true, test_lead_id: leadId }, 'Hello', undefined, routes, context);
  expect(await send()).toMatchObject({ success: true });
  const envelope = db.tables.messages[0].custom_data.tool_execution_context;
  expect(envelope.intent).toBe('Ask about availability');
  expect(envelope).not.toHaveProperty('background');
  expect(envelope.source).not.toHaveProperty('conversation_id');
  expect(envelope.source).not.toHaveProperty('message_id');
  expect(JSON.stringify(db.tables.messages)).not.toContain('Private history for another customer');
});

test('inherited merge fields obey Send Test skip-recipient policy before records or dialing', async () => {
  const context = buildToolExecutionContext({ site_id: siteId, intent: 'Ask about {{lead.unsupported_slot}}' });
  await expect(preparePublishTest(siteId, { is_test: true, test_lead_id: leadId, placeholders_when_unresolved: 'skip_recipient' },
    'Hello', undefined, routes, context)).rejects.toThrow('Unresolved merge fields');
  expect(db.writes).toHaveLength(0);
  expect(zavuFetch).not.toHaveBeenCalled();
});

test.each(['revoked', 'unknown', undefined])('blocked consent %s rejects all routes before records or provider work', async consent => {
  db.tables.leads[0].voice_call_consent_status = consent;
  await expect(prepare({}, 'Hello', [{ channel: 'sms', connection_id: 'sms' }, ...routes])).rejects.toThrow(/consent|opted out/);
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
});

test.each([
  { test_recipients: { phone: '+15559999999' } },
  { test_lead_id: undefined, test_recipient: '+15551234567' },
])('lead and recipient phone must match before tracking', async overrides => {
  await expect(prepare(overrides, 'Hello')).rejects.toThrow(/lead|match/);
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled();
});

test('do-not-call and foreign leads cannot create orphan tracking', async () => {
  db.tables.leads[0].do_not_call = true;
  await expect(prepare()).rejects.toThrow(/do-not-call/);
  db.tables.leads[0].do_not_call = false; db.tables.leads[0].site_id = randomUUID();
  await expect(prepare()).rejects.toThrow(/this site/);
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled();
});

test.each([
  { objective: 'x'.repeat(501) }, { additional_context: 'x'.repeat(4001) },
  { objective: '{{lead.missing}}', placeholders_when_unresolved: 'skip_recipient' as const },
])('all private guidance is preflighted without records', async overrides => {
  await expect(prepare(overrides)).rejects.toThrow(/exceed|Unresolved/);
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled();
});

test('test prefix is included in final greeting length check', async () => {
  await expect(prepare({}, 'x'.repeat(1000))).rejects.toThrow(/1000/);
  expect(db.writes).toHaveLength(0);
});

test('selected account mismatch cannot fall back to the first sender, including mixed routes', async () => {
  db.tables.settings[0].channels.connections[1].type = 'sms';
  await expect(prepare({}, 'Hello', [{ channel: 'sms', connection_id: 'sms' }, ...routes])).rejects.toThrow(/wrong-channel/);
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('execution rechecks consent before any test records or earlier mixed-route send', async () => {
  const send = await prepare({}, 'Hello', [{ channel: 'sms', connection_id: 'sms' }, ...routes]);
  db.tables.leads[0].voice_call_consent_status = 'revoked';
  await expect(send()).rejects.toThrow(/opted out/);
  expect(db.writes).toHaveLength(0); expect(zavuFetch).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('consent lost after tracking but before adapter dispatch remains failed and never dials', async () => {
  const send = await prepare();
  db.onSettingsRead(() => {
    if (db.tables.messages.length) db.tables.leads[0].voice_call_consent_status = 'unknown';
  });
  expect(await send()).toMatchObject({ success: false });
  expect(zavuFetch).not.toHaveBeenCalled(); expect(db.tables.voice_call_deliveries).toHaveLength(0);
  expect(db.tables.messages[0].custom_data).toMatchObject({ status: 'failed', call_status: 'failed', is_test: true });
});

test('account lost after tracking fails closed rather than choosing the first sender', async () => {
  const send = await prepare();
  db.onSettingsRead(() => {
    if (db.tables.messages.length) db.tables.settings[0].channels.connections[1].status = 'disconnected';
  });
  expect(await send()).toMatchObject({ success: false });
  expect(zavuFetch).not.toHaveBeenCalled(); expect(db.tables.voice_call_deliveries).toHaveLength(0);
  expect(db.tables.messages[0].custom_data.status).toBe('failed');
});

test('private guidance is redacted before persistence and transport, never copied to the greeting', async () => {
  const syntheticPassword = randomBytes(18).toString('hex');
  const url = new URL('https://private.example.test/context'); url.username = 'synthetic-user'; url.password = syntheticPassword;
  const send = await prepare({ additional_context: `Private reference ${url}` });
  expect(await send()).toMatchObject({ success: true });
  for (const data of [db.tables.conversations, db.tables.messages, (zavuFetch as jest.Mock).mock.calls]) {
    expect(JSON.stringify(data)).not.toContain(syntheticPassword);
  }
  expect(JSON.parse(callRequests()[0][1].body).greeting).toBe('[TEST] Hello Ada');
});

test('each Voice agent-call route gets its own server-created tracked message', async () => {
  const send = await prepare({}, 'Hello', [...routes, { channel: 'voice', connection_id: 'first', voice_mode: 'agent_call' }]);
  expect(await send()).toMatchObject({ success: true, type: 'single_test_send_per_route' });
  expect(db.tables.conversations).toHaveLength(2); expect(db.tables.messages).toHaveLength(2);
  expect(new Set(db.tables.messages.map(row => row.id)).size).toBe(2);
  expect(callRequests().map(([, options]) => JSON.parse(options.body).senderId)).toEqual(['selected-sender', 'first-sender']);
  expect(db.tables.messages.map(row => row.custom_data.connection_id)).toEqual(['selected', 'first']);
});

test('a message insert failure cleans up only the new empty site conversation', async () => {
  const send = await prepare(); db.failMessageInsert();
  await expect(send()).rejects.toThrow(/tracked Voice test message/);
  expect(db.tables.messages).toHaveLength(0); expect(db.tables.conversations).toHaveLength(0);
  expect(zavuFetch).not.toHaveBeenCalled();
});

test.each(['failed', 'unknown'] as const)('real tracked %s placement status never enters the approved worker queue', async failure => {
  const send = await prepare(); providerFailure = failure;
  expect(await send()).toMatchObject({ success: false });
  expect(callRequests()).toHaveLength(1);
  const status = failure === 'failed' ? 'failed' : 'placement_unknown';
  expect(db.tables.messages[0].custom_data).toMatchObject({ status, call_status: status, is_test: true });
  expect(db.tables.voice_call_deliveries[0].status).toBe(status);
  for (const write of db.writes.filter(entry => entry.table === 'messages')) {
    for (const row of write.rows) expect(['accepted', 'approved']).not.toContain(row.custom_data.status);
  }
});

test('legacy SMS test keeps untracked behavior', async () => {
  const send = await prepare({ objective: undefined, additional_context: undefined }, 'Hello', [{ channel: 'sms', connection_id: 'sms' }]);
  expect(await send()).toMatchObject({ success: true });
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'sms-sender', text: '[TEST] Hello' }));
  expect(db.tables.messages).toHaveLength(0); expect(db.tables.conversations).toHaveLength(0);
});

test('TTS and non-voice Send Tests never acquire interactive call context', async () => {
  const context = buildToolExecutionContext({ site_id: siteId, intent: 'Private interactive goal', background: 'Private context' });
  const send = await preparePublishTest(siteId, { is_test: true, test_lead_id: leadId }, 'Hello', undefined,
    [{ channel: 'voice', connection_id: 'selected', voice_mode: 'tts' }], context);
  expect(await send()).toMatchObject({ success: true });
  expect(db.tables.messages).toHaveLength(0);
  expect(callRequests()).toHaveLength(0);
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'voice', text: '[TEST] Hello' }));
  expect(JSON.stringify((sendChannelMessage as jest.Mock).mock.calls)).not.toContain('Private interactive goal');
});