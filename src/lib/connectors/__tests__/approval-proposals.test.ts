import { randomUUID, randomBytes } from 'node:crypto';
import { requireConversationAgent, proposeConversationConnectorAction, proposeInteractiveConnectorAction, requireSupportOrigin } from '../approval-proposals';
import { requestProposal } from '../approval-store';
import {loadConnectorCredential} from '../account-access';
import {describeDirectTool,executeDirectTool} from '../provider-direct-transport';
import {genericReviewTarget,uniqueAgentReviewAccount} from '../generic-review-target';
import type {DirectAuthorizedConnector} from '../provider-direct-policy';

import { ConnectorError, type AuthorizedConnector } from '../types';
const from = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (name:string) => from(name) } }));
jest.mock('../approval-store', () => ({ requestProposal: jest.fn() }));
jest.mock('../account-access',()=>({...jest.requireActual('../account-access'),loadConnectorCredential:jest.fn()}));
jest.mock('../generic-review-target',()=>({...jest.requireActual('../generic-review-target'),genericReviewTarget:jest.fn(),uniqueAgentReviewAccount:jest.fn()}));
jest.mock('../provider-direct-transport',()=>({describeDirectTool:jest.fn(),executeDirectTool:jest.fn()}));
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
  jest.mocked(uniqueAgentReviewAccount).mockResolvedValue(connector.id);
  jest.mocked(genericReviewTarget).mockResolvedValue({target:authority as DirectAuthorizedConnector,screens:null});
  jest.mocked(loadConnectorCredential).mockResolvedValue({revision:'r1', source:'byok', apiKey:randomBytes(32).toString('hex')});
  jest.mocked(describeDirectTool).mockResolvedValue({parameters:descriptor.inputSchema,version:descriptor.toolkitVersion,schemaHash:descriptor.schemaHash,effect:'read',description:'Read records'});
  jest.mocked(requestProposal).mockResolvedValue({status:'pending'});
});
test.each(['selected', 'all'] as const)('anonymous review can pin a new provider slug without executing (%s)', async mode => {
  const slug='RECORDS_LIST_'+randomUUID().replaceAll('-','').toUpperCase();
  const target={...authority,policy:{...authority.policy,tool_access_mode:mode,allowed_tools:mode==='all'?[]:[slug]}} as DirectAuthorizedConnector;
  jest.mocked(genericReviewTarget).mockResolvedValue({target,screens:null});
  expect(await proposeConversationConnectorAction(scope,{...input,tool_slug:slug})).toEqual({status:'pending'});
  expect(genericReviewTarget).toHaveBeenCalledWith(scope.siteId,scope.agentId,connector.id,slug,undefined,'requester');
  expect(requestProposal).toHaveBeenCalledWith(scope,expect.objectContaining({execution:'provider', tool_slug:slug, origin:{kind:'channel_public',lead_id:null},version:descriptor.toolkitVersion,
    arguments:input.arguments,schema_hash:descriptor.schemaHash,connector_id:connector.id}));
  expect(executeDirectTool).not.toHaveBeenCalled();
});
test.each(['not opted in','ambiguous','foreign conversation','disabled agent','scope revoked','malicious envelope','URL argument','wrong fields'])('rejects %s without queueing or executing',async reason=>{
  let args:unknown=input;
  const denied=new ConnectorError('APPROVAL_UNAVAILABLE','Unavailable',409);
  if(reason==='ambiguous')jest.mocked(uniqueAgentReviewAccount).mockRejectedValue(denied);
  if(reason==='not opted in'||reason==='disabled agent')jest.mocked(genericReviewTarget).mockRejectedValue(denied);
  if(reason==='scope revoked')jest.mocked(genericReviewTarget).mockResolvedValueOnce({target:authority as DirectAuthorizedConnector,screens:null}).mockRejectedValueOnce(denied);
  if(reason==='foreign conversation')sameAgent=false;
  if(reason==='malicious envelope')args={...input,approved:true,connector_id:randomUUID()};
  if(reason==='URL argument')args={...input,arguments:{url:'https://example.test/'}};
  if(reason==='wrong fields')args={...input,arguments:{pass:true}};
  await expect(proposeConversationConnectorAction(scope,args)).rejects.toThrow();
  expect(requestProposal).not.toHaveBeenCalled();expect(executeDirectTool).not.toHaveBeenCalled();
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
  expect(describeDirectTool).not.toHaveBeenCalled();
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
