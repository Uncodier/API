import { randomUUID, randomBytes } from 'node:crypto';
import { requireConversationAgent, proposeConversationConnectorAction, proposeExactSupportAction, proposeInteractiveConnectorAction, requireSupportOrigin } from '../approval-proposals';
import { requestProposal } from '../approval-store';
import { resolveConnectorPolicy, loadConnectorCredential, requireConnectorAgent } from '../access';
import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { ConnectorError, type AuthorizedConnector } from '../types';
const from = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (name:string) => from(name) } }));
jest.mock('../approval-store', () => ({ requestProposal: jest.fn() }));
jest.mock('../access', () => ({ resolveConnectorPolicy: jest.fn(), loadConnectorCredential: jest.fn(), requireConnectorAgent: jest.fn() }));
jest.mock('../composio-sessions', () => ({ ...jest.requireActual('../composio-sessions'), describeConnectorTool: jest.fn(), executeConnectorTool: jest.fn() }));
const scope = { siteId:randomUUID(), agentId:randomUUID(), conversationId:randomUUID(), idempotencyKey:randomUUID() };
const descriptor = { slug:'HUBSPOT_LIST_CONTACTS', toolkitSlug:'hubspot', toolkitVersion:'20261119', schemaHash:randomBytes(32).toString('hex'),
  inputSchema:{type:'object',properties:{limit:{type:'integer'}}}, description:'', scopes:['crm.objects.contacts.read'], scopeRequirements:null };
const input = { tool_slug:descriptor.slug, arguments:{limit:3} };
const connector = { id:randomUUID(), site_id:scope.siteId, display_name:'A', toolkit_slug:descriptor.toolkitSlug, granted_scopes:descriptor.scopes, revision:1 };
const authority = { connector, provider:{ credential_revision:'r1' }, policy:{ allowed_hosts:['assistant'], allowed_tools:[descriptor.slug],require_approval:true } } as AuthorizedConnector;
let sameAgent: boolean, accounts: unknown[];
beforeEach(() => {
  jest.resetAllMocks(); sameAgent = true; accounts = [connector];
  from.mockImplementation((name:string) => {
    const reply = name === 'agents' ? {data:{id:scope.agentId},error:null} : name === 'conversations' ? {data:sameAgent ? {id:scope.conversationId} : null,error:null} : {data:accounts,error:null};
    const query = { select:jest.fn().mockReturnThis(), eq:jest.fn().mockReturnThis(), limit:jest.fn().mockReturnThis(),
      abortSignal:jest.fn().mockImplementation(() => name !== 'connectors' ? query : Promise.resolve(reply)), maybeSingle:jest.fn().mockResolvedValue(reply) };
    return query;
  });
  jest.mocked(resolveConnectorPolicy).mockResolvedValue(authority);
  jest.mocked(loadConnectorCredential).mockResolvedValue({revision:'r1', source:'byok', apiKey:randomBytes(32).toString('hex')});
  jest.mocked(describeConnectorTool).mockResolvedValue(descriptor);
  jest.mocked(requestProposal).mockResolvedValue({status:'pending'});
});
test.each(['selected', 'all'] as const)('opted-in customer host only proposes (%s)', async mode => {
  jest.mocked(resolveConnectorPolicy).mockResolvedValue({ ...authority, policy: { ...authority.policy, tool_access_mode: mode,
    allowed_tools: mode === 'all' ? [] : [descriptor.slug] } });
  expect(await proposeConversationConnectorAction(scope,input)).toEqual({status:'pending'});
  expect(requireConnectorAgent).toHaveBeenCalledWith(connector,scope.agentId,true);
  expect(resolveConnectorPolicy).toHaveBeenCalledWith(connector,'assistant');
  expect(requestProposal).toHaveBeenCalledWith(scope,expect.objectContaining({ origin:{kind:'channel_public', lead_id:null}, version:descriptor.toolkitVersion,
    arguments:input.arguments, schema_hash:descriptor.schemaHash, connector_id:connector.id }));
  expect(executeConnectorTool).not.toHaveBeenCalled();
});
test.each(['not opted in','ambiguous','foreign conversation','disabled agent','unreviewed tool','malicious envelope','URL argument','wrong fields'])('rejects %s without queueing or executing',async reason => {
  let args: unknown = input;
  if (reason === 'not opted in') jest.mocked(resolveConnectorPolicy).mockResolvedValue({...authority,policy:{...authority.policy,require_approval:false}});
  if (reason === 'ambiguous') accounts = [connector, {...connector,id:randomUUID()}];
  if (reason === 'foreign conversation') sameAgent = false;
  if (reason === 'disabled agent') jest.mocked(requireConnectorAgent).mockRejectedValue(new ConnectorError('ACCESS_DENIED','Denied',403));
  if (reason === 'unreviewed tool') args = { ...input, tool_slug:'HTTP_REQUEST' };
  if (reason === 'malicious envelope') args = { ...input, approved:true, connector_id:randomUUID() };
  if (reason === 'URL argument') args = { ...input, arguments:{url:'https://example.test/'} };
  if (reason === 'wrong fields') args = { ...input, arguments:{pass:true} };
  await expect(proposeConversationConnectorAction(scope,args)).rejects.toThrow();
  expect(requestProposal).not.toHaveBeenCalled(); expect(executeConnectorTool).not.toHaveBeenCalled();
});
test('identical interactive turn/action gives same key, actor pinned and context proof required',async () => {
  const context = { siteId:scope.siteId,userId:randomUUID(),agentId:scope.agentId,instanceId:randomUUID(),requestId:randomUUID(),sourceDigest:randomBytes(32).toString('hex'),host:'assistant' as const };
  const auth = { ...authority, requestOnly:true as const, policy:{...authority.policy,require_approval:true} };
  await expect(proposeInteractiveConnectorAction({...context,requestId:undefined},auth,descriptor,input.arguments)).rejects.toThrow();
  for (let i=0;i<2;i++) await proposeInteractiveConnectorAction(context,auth,descriptor,input.arguments);
  const calls = jest.mocked(requestProposal).mock.calls;
  expect(calls[0][0]).toEqual(calls[1][0]); expect(calls[0][0]).toMatchObject({ conversationId:null,agentId:scope.agentId,source:{kind:'instance_log',id:context.requestId,digest:context.sourceDigest} });
  expect(calls[0][1].origin).toEqual({ kind:'interactive',instance_id:context.instanceId,user_id:context.userId });
});


test('customer channels cannot probe for a connected database or propose table discovery', async () => {
  await expect(proposeConversationConnectorAction(scope, { tool_slug: 'SUPABASE_LIST_TABLES', arguments: {} }))
    .rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
  expect(from).not.toHaveBeenCalled(); expect(describeConnectorTool).not.toHaveBeenCalled();
  expect(requestProposal).not.toHaveBeenCalled(); expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('member support cannot queue an instance-only tool even with an exact account and approval policy', async () => {
  const access = { ...authority, connector: { ...authority.connector, toolkit_slug: 'supabase' },
    policy: { ...authority.policy, require_approval: true } };
  await expect(proposeExactSupportAction(scope, { kind: 'support_member', user_id: randomUUID() }, access,
    { ...descriptor, toolkitSlug: 'supabase', slug: 'SUPABASE_LIST_TABLES' }, {})).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
  expect(requestProposal).not.toHaveBeenCalled();
});

// Evaluate the actual query predicates against local rows; no Supabase or provider connection.
const owner = randomUUID(), lead = randomUUID();
const member = { kind: 'support_member', user_id: owner } as const;
function supportRows(conversation: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) {
  const rows: Record<string, Record<string, unknown>> = {
    agents: { id: scope.agentId, site_id: scope.siteId, role: 'Customer Support', status: 'active', ...agent },
    conversations: { id: scope.conversationId, site_id: scope.siteId, agent_id: scope.agentId, user_id: owner,
      visitor_id: null, lead_id: null, channel: 'web', custom_data: {}, ...conversation },
  };
  from.mockImplementation((table: string) => {
    const row = rows[table]; let matches = true;
    const query = { select: () => query, abortSignal: () => query,
      eq: (key: string, value: unknown) => { matches &&= row[key] === value; return query; },
      maybeSingle: async () => ({ data: matches ? row : null, error: null }) };
    return query;
  });
}
const checkOrigin = (origin: Parameters<typeof requireSupportOrigin>[3]) =>
  requireSupportOrigin(scope.siteId, scope.conversationId, scope.agentId, origin);

test.each([
  { user_id: randomUUID() }, { site_id: randomUUID() }, { id: randomUUID() }, { agent_id: randomUUID() },
  { lead_id: lead }, { visitor_id: randomUUID() }, { channel: 'email' }, { custom_data: { source: 'comment' } },
  { custom_data: { voice_mode: true } }, { custom_data: { channel_delivery: true } }, { custom_data: { channel: 'sms' } },
  { custom_data: [] }, { custom_data: 'unexpected legacy metadata' },
])('member approval requires a currently private and owned support conversation (%j)', async change => {
  supportRows(change);
  await expect(checkOrigin(member)).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
});

test('an internal review conversation is never the source of a public channel call or published read', async () => {
  supportRows({ channel: 'internal_review' });
  await expect(requireConversationAgent(scope.siteId,scope.conversationId,scope.agentId,{ kind:'channel_public', lead_id:null })).rejects.toMatchObject({ code:'APPROVAL_UNAVAILABLE' });
  await expect(checkOrigin({ kind:'support_publication', publication_hash:randomBytes(32).toString('hex'), audience:'anonymous', lead_id:null })).rejects.toMatchObject({ code:'APPROVAL_UNAVAILABLE' });
  expect(describeConnectorTool).not.toHaveBeenCalled();
});

test('verified publication binds its lead; anonymous publication does not borrow a member identity', async () => {
  const publication = { kind: 'support_publication', publication_hash: randomBytes(32).toString('hex') } as const;
  supportRows(); await expect(checkOrigin(member)).resolves.toBeUndefined();
  supportRows({ lead_id: lead, user_id: null });
  const verified = { ...publication, audience: 'verified', lead_id: lead } as const;
  await expect(checkOrigin(verified)).resolves.toBeUndefined();
  await expect(checkOrigin({ ...verified, lead_id: randomUUID() })).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
  const anonymous = { ...publication, audience: 'anonymous', lead_id: null } as const;
  await expect(checkOrigin(anonymous)).resolves.toBeUndefined();
  for (const change of [{ role: 'Sales' }, { status: 'inactive' }, { id: randomUUID() }, { site_id: randomUUID() }]) {
    supportRows({}, change);
    for (const origin of [member, anonymous, verified]) {
      await expect(checkOrigin(origin)).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
    }
  }
});


test('the opaque external review cannot outlive Support role or verified lead binding', async () => {
  const origin = {kind:'channel_public',lead_id:lead} as const;
  supportRows({lead_id:lead});
  await expect(requireConversationAgent(scope.siteId,scope.conversationId,scope.agentId,origin)).resolves.toBeUndefined();
  supportRows({lead_id:lead},{role:'Sales'});
  await expect(requireConversationAgent(scope.siteId,scope.conversationId,scope.agentId,origin)).rejects.toThrow();
  supportRows({lead_id:randomUUID()});
  await expect(requireConversationAgent(scope.siteId,scope.conversationId,scope.agentId,origin)).rejects.toThrow();
});
