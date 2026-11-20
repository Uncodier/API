import { randomUUID } from 'node:crypto';
import { enableMemberConversationGateway } from '../channel-member-host';
import { supportConnectorTool } from '../support-runtime-contract';
import { channelRequestTool } from '../channel-request';
import { emitBoundCommand, requestBoundCommandReview } from '../channel-command';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';
import { proposeConversationConnectorAction } from '../approval-proposals';

jest.mock('@/lib/connectors/channel-command-row', () => ({ isAssignedChannelCommand: jest.fn(async () => true) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn() }));
jest.mock('../approval-proposals', () => ({ proposeConversationConnectorAction: jest.fn() }));
const req = new Request('https://test.invalid', { headers: { authorization: `Bearer ${randomUUID()}` } });
const site = randomUUID(), agent = randomUUID(), conv = randomUUID(), owner = randomUUID(), id = randomUUID();
const row = { id: conv, site_id: site, user_id: owner, agent_id: agent, visitor_id: null, lead_id: null, channel: null };
const create = () => ({ id, site_id: site, agent_id: agent, user_id: owner, tools: [] });
const support = { id: agent, site_id: site, role: 'Customer Support', status: 'active' };
let query: any, agentQuery: any;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ userId: owner, siteId: site, internal: false });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  query = { select: jest.fn(), eq: jest.fn(), abortSignal: jest.fn(), maybeSingle: jest.fn().mockResolvedValue({ data: row }) };
  for (const key of ['select','eq','abortSignal']) query[key].mockReturnValue(query);
  agentQuery = { ...query, maybeSingle: jest.fn().mockResolvedValue({data: support}) };
  for (const key of ['select','eq','abortSignal']) agentQuery[key] = jest.fn(() => agentQuery);
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => table === 'agents' ? agentQuery : query);
});
it('requires the verified workspace conversation owner and assigned agent even for a member of the site', async () => {
  for (const patch of [{ user_id: randomUUID() }, { agent_id: randomUUID() }, { site_id: randomUUID() }, { id: randomUUID() },
    { lead_id: randomUUID() }, { visitor_id: randomUUID() }, { channel: 'whatsapp' },
    { custom_data: { channel_delivery: true } }, { custom_data: { source: 'comment' } }]) {
    query.maybeSingle.mockResolvedValue({ data: { ...row,...patch } });
    const cmd = create(); await enableMemberConversationGateway(req, cmd, conv); expect(cmd.tools).not.toContainEqual({ type: 'function', function: supportConnectorTool });
  }
  query.maybeSingle.mockResolvedValue({data: row});
  const cmd = create(); await enableMemberConversationGateway(req, cmd, conv);
  expect(cmd.tools).toEqual([supportConnectorTool, channelRequestTool].map(tool => ({ type: 'function', function: tool })));
  const impersonated = { ...create(), user_id: randomUUID(), tools: [{ name: supportConnectorTool.name }] };
  await enableMemberConversationGateway(req, impersonated, conv); expect(impersonated.tools).toEqual([]);
  const proposal = { tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'is:unread' } };
  await emitBoundCommand(cmd, cmd, async () => {
    await requestBoundCommandReview(id, site, proposal);
    expect(proposeConversationConnectorAction).toHaveBeenCalledWith({ siteId: site, agentId: agent, conversationId: conv,
      memberUserId: owner, idempotencyKey: expect.stringMatching(/^channel-member:/) }, proposal);
    jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(false);
    await requestBoundCommandReview(id, site, proposal);
    expect(proposeConversationConnectorAction).toHaveBeenCalledTimes(1);
  });
});
it('does not install a capability for middleware metadata, a bare service credential or an unverified member', async () => {
  const cmd = create(); await enableMemberConversationGateway(new Request('https://test.invalid', { headers: { 'x-auth-user-id': owner } }), cmd, conv);
  expect(resolveToolRequestPrincipal).not.toHaveBeenCalled();
  for (const principal of [null, { internal: true, userId: null, siteId: null }]) {
    jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(principal);
    await enableMemberConversationGateway(req, cmd, conv);
  }
  expect(cmd.tools).toEqual([]); expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('retains blind review only for other agent roles, including an owner’s private agent thread', async () => {
  for (const override of [{ role: 'Sales/CRM Specialist' }, { status: 'disabled' }, { site_id: randomUUID() }]) {
    agentQuery.maybeSingle.mockResolvedValue({data:{...support,...override}});
    const cmd = create();
    await enableMemberConversationGateway(req, cmd, conv);
    expect(cmd.tools).toEqual([{ type: 'function', function: channelRequestTool }]);
  }
});
