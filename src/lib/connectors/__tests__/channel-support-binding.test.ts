import { sourceDigest } from '../approval-source';
import { randomUUID, randomBytes } from 'node:crypto';
import { supportConnectorRequestHost } from '@/app/api/agents/customerSupport/message/connector-request-host';
import { commentConversationId, commentMetadata, conversationMetadata } from '@/lib/services/social-comments/metadata';
import { commentMessageIds } from '@/lib/services/social-comments/persistence';
import { issueVisitorTurn, verifyVisitorTurn } from '../channel-visitor-turn';
import { issueVisitorSessionToken } from '@/lib/security/visitor-session-token';
import { visitorSessionAuthorizationService } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));
jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({ visitorSessionAuthorizationService: { authorizeBrowserRequest: jest.fn() } }));
const siteId = randomUUID(), conversationId = randomUUID(), agentId = randomUUID(), visitorId = randomUUID(), sessionId = randomUUID();
const visitor = { siteId, visitorId, sessionId, leadId: null };
const row = { id: conversationId, site_id: siteId, agent_id: agentId, visitor_id: visitorId, lead_id: null, channel: 'website_chat' };
const input = { siteId, conversationId, agentId, requestedConversationId: conversationId, message: 'Customer inquiry', origin: 'website_chat', browserIdentity: visitor };
const env = { visitor: process.env.VISITOR_SESSION_TOKEN_SECRET, service: process.env.SERVICE_API_KEY };
let serviceKey: string, query: any, agentQuery: any, request: Request;
beforeEach(async () => {
  process.env.VISITOR_SESSION_TOKEN_SECRET = randomBytes(32).toString('hex');
  process.env.SERVICE_API_KEY = serviceKey = randomBytes(32).toString('hex');
  const token = await issueVisitorSessionToken(visitor);
  request = new Request('https://test.invalid', { headers: { 'x-visitor-session-token': token } });
  query = { select: jest.fn(), eq: jest.fn(), abortSignal: jest.fn(), maybeSingle: jest.fn(async () => ({data: row})) };
  for (const key of ['eq','select','abortSignal']) query[key].mockReturnValue(query);
  agentQuery = { maybeSingle: jest.fn().mockResolvedValue({data:{id:agentId,site_id:siteId,role:'Customer Support',status:'active'}}) };
  for (const key of ['eq','select','abortSignal']) agentQuery[key] = jest.fn(() => agentQuery);
  jest.mocked(supabaseAdmin.schema).mockReturnValue({ from: (table: string) => table === 'agents' ? agentQuery : query } as any);
  jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValue(visitor);
});
afterAll(() => {
  for (const [name, value] of Object.entries({ VISITOR_SESSION_TOKEN_SECRET: env.visitor, SERVICE_API_KEY: env.service })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
it('binds a signed active visitor and DB conversation/agent and rechecks each use', async () => {
  const host = await supportConnectorRequestHost({ ...input, request });
  expect(await host?.resolve()).toEqual({ conversationId, siteId, agentId, audience: 'anonymous', idempotencyKey: expect.any(String) });
  expect(await supportConnectorRequestHost({ ...input, request, suppliedAgentId: agentId })).toBeUndefined();
  expect(await supportConnectorRequestHost({ ...input, request, requestedConversationId: randomUUID() })).toBeUndefined();
  agentQuery.maybeSingle.mockResolvedValueOnce({data:{id:agentId,site_id:siteId,role:'other',status:'active'}});
  expect(await host?.resolve()).toBeNull();
  query.maybeSingle.mockResolvedValueOnce({ data: { ...row, visitor_id: randomUUID() } });
  expect(await host?.resolve()).toBeNull();
  query.maybeSingle.mockResolvedValueOnce({ data: { ...row, agent_id: randomUUID() } });
  expect(await host?.resolve()).toBeNull();
  jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValue(null);
  expect(await host?.resolve()).toBeNull();
});
it('workflow handoff requires a genuine server request and signed exact message/session/thread; retries share one key', async () => {
  const turn = randomBytes(32).toString('hex');
  const visitorTurn = await issueVisitorTurn(request, visitor, conversationId, turn, input.message);
  expect(visitorTurn).toBeTruthy();
  expect(verifyVisitorTurn(visitorTurn, 'replacement message', turn)).toBeUndefined();
  expect(verifyVisitorTurn(visitorTurn + 'x', input.message, turn)).toBeUndefined();
  const service = new Request('https://test.invalid', { headers: { 'x-api-key': serviceKey } });
  const args = { ...input, visitorTurn, originMessageId: turn, browserIdentity: null, request: service };
  expect(await (await supportConnectorRequestHost(args))?.resolve()).toEqual({ siteId, agentId, conversationId, audience: 'anonymous', idempotencyKey: `channel-request:${turn}` });
  expect(await supportConnectorRequestHost({ ...args, conversationId: randomUUID() })).toBeUndefined();
  expect(await supportConnectorRequestHost({ ...args, request })).toBeUndefined();
  expect(await supportConnectorRequestHost({ ...args, originMessageId: 'other' })).toBeUndefined();
});
it('service metadata is not authentication; exact persisted inbound scope is required', async () => {
  const inboundId = randomUUID();
  const args = { ...input, browserIdentity: null, request, inboundId, origin: 'whatsapp', originMessageId: 'event', metadata: { channel: 'whatsapp', source: 'zavu_inbound_message', connection_id: 'conn', zavu_sender_id: 'sender', zavu_from: 'from' } };
  const receipt = { conversation_id: conversationId, content: args.message, custom_data: { origin_message_id: args.originMessageId } };
  const providerRow = { ...row, channel: args.origin, lead_id: randomUUID() };
  expect(await supportConnectorRequestHost(args)).toBeUndefined();
  args.request = new Request('https://test.invalid', { headers: { 'x-api-key-data': '{"isService":true}' } });
  expect(await supportConnectorRequestHost(args)).toBeUndefined();
  args.request = new Request('https://test.invalid', { headers: { 'x-api-key': serviceKey } });
  query.maybeSingle.mockResolvedValueOnce({ data: { conversation_id: randomUUID() } });
  expect(await supportConnectorRequestHost(args)).toBeUndefined();
  query.maybeSingle.mockResolvedValueOnce({ data: receipt }).mockResolvedValueOnce({ data: providerRow });
  const providerHost = await supportConnectorRequestHost(args);
  query.maybeSingle.mockResolvedValueOnce({ data: receipt }).mockResolvedValueOnce({ data: providerRow });
  expect(await providerHost?.resolve()).toEqual({ siteId, agentId, conversationId, audience: 'anonymous', source:{kind:'message',id:inboundId,digest:sourceDigest(input.message)}, idempotencyKey: `channel-request:${inboundId}` });
  expect(query.eq.mock.calls).toEqual(expect.arrayContaining([['id',inboundId],['agent_id',agentId],['role','user'],
    ['custom_data->>source','zavu_inbound_message'],['custom_data->>connection_id','conn'],
    ['custom_data->>zavu_sender_id','sender'],['custom_data->>zavu_from','from']]));
  for (const changed of [{ ...receipt, content: 'Different turn' }, { ...receipt, custom_data: { origin_message_id: 'other' } }]) {
    query.maybeSingle.mockResolvedValueOnce({ data: changed }).mockResolvedValue({ data: providerRow });
    expect(await providerHost?.resolve()).toBeNull();
  }
});

it('binds verified identity only to a current matching grant, including during signed handoff', async () => {
  const identified = { ...visitor, leadId: randomUUID() };
  query.maybeSingle.mockResolvedValue({ data: { ...row, lead_id: identified.leadId } });
  jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValue(identified);
  const direct = await supportConnectorRequestHost({ ...input, request, browserIdentity: identified });
  const turn = randomBytes(32).toString('hex');
  const visitorTurn = await issueVisitorTurn(request, identified, conversationId, turn, input.message);
  const handedOff = await supportConnectorRequestHost({ ...input, browserIdentity: null, visitorTurn,
    originMessageId: turn, request: new Request('https://test.invalid', { headers: { 'x-api-key': serviceKey } }) });
  for (const host of [direct, handedOff]) {
    expect(await host?.resolve()).toEqual({ siteId, conversationId, agentId, audience: 'verified', leadId: identified.leadId, idempotencyKey: expect.any(String) });
    jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValueOnce(visitor);
    expect(await host?.resolve()).toBeNull();
  }
});

it('never places verified-only data in a visitor-only thread that remains readable after logout', async () => {
  const identified = { ...visitor, leadId: randomUUID() };
  jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValue(identified);
  const host = await supportConnectorRequestHost({ ...input, request, browserIdentity: identified });
  expect(await host?.resolve()).toEqual({ siteId, conversationId, agentId, audience: 'anonymous', idempotencyKey: expect.any(String) });
});

it('requires a website turn and website thread, even for the current canonical lead', async () => {
  const identified = { ...visitor, leadId: randomUUID() };
  const thread = { ...row, lead_id: identified.leadId };
  const args = { ...input, request, browserIdentity: identified };
  jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValue(identified);
  query.maybeSingle.mockResolvedValue({ data: thread });
  const host = await supportConnectorRequestHost(args);
  expect(await host?.resolve()).toMatchObject({ audience: 'verified', leadId: identified.leadId });
  for (const change of [{ origin: 'whatsapp' }, { channelDelivery: true }, { metadata: { source: 'comment' } }]) {
    expect(await supportConnectorRequestHost({ ...args, ...change })).toBeUndefined();
  }
  query.maybeSingle.mockResolvedValueOnce({ data: { ...thread, channel: null, custom_data: { channel: 'web' } } });
  expect(await host?.resolve()).toMatchObject({ audience: 'verified', leadId: identified.leadId });
  for (const change of [{ channel: 'email' }, { channel: null }, { custom_data: { channel: 'sms' } },
    { custom_data: { channel_delivery: true } }, { custom_data: { source: 'comment' } }, { custom_data: { is_private: true } }, { custom_data: { voice_mode: 'agent_call' } }]) {
    query.maybeSingle.mockResolvedValue({ data: { ...thread, ...change } });
    expect(await host?.resolve()).toBeNull();
  }
});

it('uses the stored comment scope and per-comment turn, never a member or lead audience', async () => {
  const metadata = commentMetadata({ source: 'comment', publisher_account_id: 'account', outstand_post_id: 'post',
    platform_comment_id: 'comment-1', author_id: 'author' }, 'instagram')!;
  const conversationId = commentConversationId(siteId, metadata);
  const args = { ...input, conversationId, requestedConversationId: conversationId, browserIdentity: null, metadata, origin: 'instagram',
    request: new Request('https://test.invalid', { headers: { 'x-api-key': serviceKey } }) };
  const thread = { ...row, id: conversationId, channel: 'instagram', lead_id: randomUUID(), custom_data: conversationMetadata(metadata) };
  query.maybeSingle.mockResolvedValue({ data: thread });
  for (const id of ['comment-1', 'comment-2']) {
    const host = await supportConnectorRequestHost({ ...args, metadata: { ...metadata, platform_comment_id: id } });
    expect(await host?.resolve()).toEqual({ siteId, agentId, conversationId, audience: 'anonymous',
      source:{kind:'message',id:commentMessageIds(conversationId,id).userMessageId,digest:sourceDigest(input.message)},
      idempotencyKey: `channel-request:${commentMessageIds(conversationId, id).userMessageId}` });
    query.maybeSingle.mockResolvedValueOnce({ data: { ...thread, custom_data: { ...thread.custom_data, author_id: 'other' } } });
    expect(await host?.resolve()).toBeNull();
  }
});
