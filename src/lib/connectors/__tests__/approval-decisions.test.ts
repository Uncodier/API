import { randomBytes, randomUUID } from 'node:crypto';
import { decideConnectorApproval, listConnectorApprovals } from '../approval-decisions';
import { actionSnapshot, type ApprovalRow } from '../approval-action';
import * as store from '../approval-store';
import * as access from '../access';
import { describeConnectorTool, executeConnectorTool, hashConnectorSchema } from '../composio-sessions';
import { requireConversationAgent, requireSupportOrigin } from '../approval-proposals';
import { loadSupportPublication } from '../support-runtime-publication';
import { publishedGmailInput } from '../support-public-gmail';
import { assistantConnectorContext } from '../host-context';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { ConnectorError, type AuthorizedConnector } from '../types';

jest.mock('../approval-store', () => ({ getApproval: jest.fn(), pendingRows: jest.fn(), decideRow: jest.fn(), finishRow: jest.fn() }));
jest.mock('../approval-proposals', () => ({ requireConversationAgent: jest.fn(), requireSupportOrigin:jest.fn() }));
jest.mock('../support-runtime-publication', () => ({loadSupportPublication:jest.fn()}));
jest.mock('../host-context', () => ({ assistantConnectorContext: jest.fn() }));
jest.mock('../access', () => ({ requireConnectorSiteAccess: jest.fn(), requireConnectorAgent: jest.fn(), resolveManagerAction: jest.fn(), resolveConnectorAction: jest.fn(), loadConnectorCredential: jest.fn() }));
jest.mock('../composio-sessions', () => ({ ...jest.requireActual('../composio-sessions'), describeConnectorTool: jest.fn(), executeConnectorTool: jest.fn() }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ ...jest.requireActual('@/app/api/agents/tools/router/screen-access'), loadToolScreenAccess: jest.fn() }));
const denied = () => new ConnectorError('ACCESS_DENIED', 'Denied', 403);
const site = randomUUID(), actor = randomUUID(), id = randomUUID(), agent = randomUUID();
const descriptor = { slug: 'HUBSPOT_LIST_CONTACTS', toolkitSlug: 'hubspot', description: '', toolkitVersion: '1.2', scopes: ['crm.objects.contacts.read'],
  schemaHash: randomBytes(32).toString('hex'), scopeRequirements: null, inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };
let auth: AuthorizedConnector;
let row: ApprovalRow;
const decide = (decision: 'approve' | 'reject' = 'approve') => decideConnectorApproval(site, id, actor, decision);
beforeEach(() => {
  jest.resetAllMocks();
  const providerId = randomUUID(), project = 'project-test';
  auth = { connector: { id: randomUUID(), site_id: site, display_name: 'Sales', toolkit_slug: 'hubspot', revision: 1,
    granted_scopes: descriptor.scopes, provider_id: providerId, provider_project_id: project, provider_account_id: 'account-test',
    auth_config_id: 'auth-test', provider_status: 'ACTIVE', enabled: true, revocation_pending: false, created_by: actor, verified_at: null },
    provider: { id: providerId, site_id: site, provider: 'composio', project_id: project, provider_user_id: 'user-test',
      status: 'active', credential_revision: 'r1' },
    policy: { require_approval: true, tool_access_mode: 'all', allowed_tools: [], allowed_hosts: ['assistant'] } };
  row = { id, created_at:new Date().toISOString(), site_id: site, agent_id: agent, actor_user_id: null, conversation_id: randomUUID(), status: 'pending',
    expires_at: new Date(Date.now()+60000).toISOString(), action: actionSnapshot({ kind: 'channel_public', lead_id: null }, auth, descriptor, { limit: 4 }) };
  jest.mocked(access.resolveManagerAction).mockImplementation(async () => auth);
  jest.mocked(access.resolveConnectorAction).mockImplementation(async () => auth);
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: true, blockedScreens: [] });
  jest.mocked(store.pendingRows).mockResolvedValue([row]);
  jest.mocked(store.getApproval).mockResolvedValue(row);
  jest.mocked(store.decideRow).mockImplementation(async (_site,_id,user,decision) => {
    if (row.status !== 'pending') throw new ConnectorError('CONFLICT','Already claimed',409);
    row.status = decision === 'approve' ? 'executing' : 'rejected'; row.actor_user_id = user; return row;
  });
  jest.mocked(access.loadConnectorCredential).mockResolvedValue({ revision: 'r1', source: 'byok', apiKey: randomBytes(32).toString('hex') });
  jest.mocked(describeConnectorTool).mockResolvedValue(descriptor);
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    await input.beforeDispatch(); return { successful: true, data: { private: 'approver only' }, logId: undefined };
  });
});

test('only the winning manager dispatches; exactly stored arguments and requesting agent, private result only for winner', async () => {
  const results = await Promise.allSettled([decide(), decide()]);
  expect(results.filter(r => r.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: { id, status: 'completed', result: { private: 'approver only' } } }]);
  expect(store.decideRow).toHaveBeenCalledWith(site, id, actor, 'approve');
  expect(access.resolveManagerAction).toHaveBeenCalledWith(site, actor, auth.connector.id, descriptor.slug);
  expect(access.requireConnectorAgent).toHaveBeenCalledWith(auth.connector, agent, true);
  expect(requireConversationAgent).toHaveBeenCalledWith(site, row.conversation_id, agent, row.action.origin);
  expect(executeConnectorTool).toHaveBeenCalledTimes(1);
  expect(executeConnectorTool).toHaveBeenCalledWith(expect.objectContaining({ toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, allowedTools: [descriptor.slug], input: { limit: 4 } }));
  expect(store.finishRow).toHaveBeenCalledWith(site,id,actor,'succeeded');
});

test.each([10, 501])('a retained Gmail request keeps the provider pin and exact omitted count (provider default %i)', async def => {
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const pinned = { slug: 'GMAIL_FETCH_EMAILS', toolkitSlug: 'gmail', toolkitVersion: '20261119_00', scopes, scopeRequirements: null,
    inputSchema: { type: 'object', properties: { max_results: { type: 'integer', default: def }, user_id: { type: 'string' } } } };
  const tool = { ...pinned, schemaHash: hashConnectorSchema(pinned), description: 'Read Gmail.' };
  auth.connector.toolkit_slug = 'gmail'; auth.connector.granted_scopes = scopes;
  row.action = actionSnapshot(row.action.origin, auth, tool, {});
  const saved = structuredClone(row.action);
  jest.mocked(describeConnectorTool).mockResolvedValue(tool);
  if (def === 10) {
    await expect(decide()).resolves.toEqual({ id, status: 'completed', result: { private: 'approver only' } });
    expect(executeConnectorTool).toHaveBeenCalledWith(expect.objectContaining({ input: {}, schemaHash: saved.schema_hash,
      requiredScopes: scopes, toolkitVersion: saved.version }));
  } else {
    await expect(decide()).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
    expect(executeConnectorTool).not.toHaveBeenCalled();
    expect(store.finishRow).toHaveBeenCalledWith(site, id, actor, 'failed');
  }
  expect(row.action).toEqual(saved); // no guessed count or rewritten legacy snapshot
});

test('private list contains review fields only and rejection never executes', async () => {
  expect(await listConnectorApprovals(site, actor)).toEqual({ items: [{ id, created_at:row.created_at, context:{agent_label:'Agent', conversation_title:null, instance_label:null, instance_id:null, source_excerpt:null}, agent_id: agent, connector_id: auth.connector.id,
    conversation_id: row.conversation_id, review_conversation_id: row.conversation_id, account_label: 'Sales', tool_slug: descriptor.slug, arguments: { limit: 4 }, version: descriptor.toolkitVersion, expires_at: row.expires_at }] });
  expect(await decide('reject')).toEqual({ id, status: 'rejected' });
  expect(executeConnectorTool).not.toHaveBeenCalled();
});
test('routes an instance request only through its persisted conversation, never an instance or request pseudo ID', async () => {
  const instance = randomUUID(), user = randomUUID(), thread = randomUUID();
  row.action.origin = { kind: 'interactive', instance_id: instance, user_id: user }; row.conversation_id = null;
  jest.mocked(assistantConnectorContext).mockReturnValue(async () => ({siteId:site, userId:user, agentId:agent, instanceId:instance, host:'assistant'}));
  expect((await listConnectorApprovals(site,actor)).items).toEqual([]);
  row.connector_approval_review_links = {review_conversation_id:thread};
  expect((await listConnectorApprovals(site,actor)).items).toEqual([expect.objectContaining({id, conversation_id:null, review_conversation_id:thread})]);
  expect(store.decideRow).not.toHaveBeenCalled();
});
test('non-manager cannot read storage or claim', async () => {
  jest.mocked(access.requireConnectorSiteAccess).mockRejectedValue(denied());
  await expect(listConnectorApprovals(site, actor)).rejects.toThrow(); await expect(decide()).rejects.toThrow();
  expect(access.requireConnectorSiteAccess).toHaveBeenCalledWith(site, actor, true);
  expect(store.getApproval).not.toHaveBeenCalled(); expect(store.pendingRows).not.toHaveBeenCalled();
});
test.each(['grant','revision','mode','scope','screen','expiry','wrong site','changed conversation agent'])('unactionable %s hidden and denied', async reason => {
  if (reason === 'grant') jest.mocked(access.resolveManagerAction).mockRejectedValue(denied());
  if (reason === 'revision') auth.connector.revision++;
  if (reason === 'mode') auth.policy.tool_access_mode = 'selected';
  if (reason === 'scope') auth.connector.granted_scopes = [];
  if (reason === 'screen') jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: ['people'] });
  if (reason === 'expiry') row.expires_at = new Date(0).toISOString();
  if (reason === 'wrong site') row.site_id = randomUUID();
  if (reason === 'changed conversation agent') jest.mocked(requireConversationAgent).mockRejectedValue(denied());
  expect(await listConnectorApprovals(site,actor)).toEqual({ items: [] }); await expect(decide()).rejects.toThrow();
  expect(store.decideRow).not.toHaveBeenCalled(); expect(executeConnectorTool).not.toHaveBeenCalled();
});
test('review cannot outlive original interactive member authority', async () => {
  const original = { kind: 'interactive', user_id: randomUUID(), instance_id: randomUUID() } as const;
  row.action.origin = original; row.conversation_id = null;
  jest.mocked(assistantConnectorContext).mockReturnValue(async () => ({ siteId: site, userId: original.user_id, instanceId: original.instance_id, agentId: agent, host: 'assistant' }));
  jest.mocked(access.resolveConnectorAction).mockImplementation(async ctx => { if (ctx.userId === original.user_id) throw denied(); return auth; });
  await expect(decide()).rejects.toThrow(); expect(store.decideRow).not.toHaveBeenCalled();
});

test.each(['owner','grant'])('support approval revalidates original conversation member %s, not just manager', async reason => {
  const user = randomUUID(); row.action.origin = {kind:'support_member',user_id:user};
  if (reason === 'owner') jest.mocked(requireSupportOrigin).mockRejectedValue(denied());
  if (reason === 'grant') jest.mocked(access.resolveConnectorAction).mockImplementation(async ctx => { if (ctx.userId === user) throw denied(); return auth; });
  await expect(decide()).rejects.toThrow(); expect(store.decideRow).not.toHaveBeenCalled();
  expect(requireSupportOrigin).toHaveBeenCalledWith(site,row.conversation_id,agent,row.action.origin);
});

test.each(['completed','label changed','disabled in preparation','argument drift','lead reassigned'])('scoped publication review: %s', async reason => {
  const labelId = 'Label_12', leadId = randomUUID();
  const publication = {labelId,revision:1,audience:'verified'} as const;
  const tool = {...descriptor,slug:'GMAIL_FETCH_EMAILS',toolkitSlug:'gmail',scopes:['https://www.googleapis.com/auth/gmail.readonly'],
    inputSchema:{type:'object',properties:{label_ids:{type:'array',items:{type:'string'}},max_results:{type:'integer'},ids_only:{type:'boolean'},
      verbose:{type:'boolean'},include_payload:{type:'boolean'},include_spam_trash:{type:'boolean'}}}};
  auth.connector.toolkit_slug = 'gmail'; auth.connector.granted_scopes = tool.scopes;
  row.action = actionSnapshot({kind:'support_publication',audience:'verified',publication_hash:hashConnectorSchema(publication),lead_id:leadId},
    auth, tool, publishedGmailInput(labelId));
  jest.mocked(describeConnectorTool).mockResolvedValue(tool);
  jest.mocked(loadSupportPublication).mockResolvedValue(reason === 'label changed' ? {...publication,labelId:'Label_56'} : publication);
  if (reason === 'argument drift') row.action.arguments.label_ids = ['INBOX'];
  if (reason === 'lead reassigned') jest.mocked(requireSupportOrigin).mockRejectedValue(denied());
  let sent = false;
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    if (reason === 'disabled in preparation') jest.mocked(loadSupportPublication).mockResolvedValue(null);
    await input.beforeDispatch(); sent = true;
    return {successful:true,data:{messages:[{subject:'Published',labelIds:[labelId],snippet:'Secret'}]},logId:undefined};
  });
  if (reason === 'completed') expect(await decide()).toEqual({id,status:'completed',result:{titles:['Published'],limited:false}});
  else await expect(decide()).rejects.toThrow();
  expect(requireSupportOrigin).toHaveBeenCalledWith(site,row.conversation_id,agent,row.action.origin);
  expect(sent).toBe(reason === 'completed');
});
test.each(['changed schema','grant revoked during preparation','provider timeout'])('postclaim %s is terminal; never sends again', async reason => {
  if (reason === 'changed schema') jest.mocked(describeConnectorTool).mockResolvedValue({ ...descriptor, schemaHash: randomBytes(32).toString('hex') });
  else jest.mocked(executeConnectorTool).mockImplementation(async input => {
    if (reason.startsWith('grant')) jest.mocked(access.requireConnectorSiteAccess).mockRejectedValue(denied());
    await input.beforeDispatch(); throw new Error('Timeout');
  });
  await expect(decide()).rejects.toThrow(); await expect(decide()).rejects.toThrow();
  expect(store.finishRow).toHaveBeenCalledWith(site,id,actor,'failed');
  expect(executeConnectorTool).toHaveBeenCalledTimes(reason === 'changed schema' ? 0 : 1);
});

test('oversized result omitted, successful finish stores no payload', async () => {
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    await input.beforeDispatch(); return { successful: true, data: { value: 'z'.repeat(32 * 1024) }, logId: undefined };
  });
  expect(await decide()).toEqual({ id, status: 'completed', result_omitted: true });
  expect(store.finishRow).toHaveBeenCalledWith(site,id,actor,'succeeded');
});

test('revocation after dispatch withholds even a successful read from a former manager', async () => {
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    await input.beforeDispatch();
    jest.mocked(access.requireConnectorSiteAccess).mockRejectedValue(denied());
    return { successful:true, data:{ private:'not released' }, logId:undefined };
  });
  await expect(decide()).rejects.toMatchObject({ code:'ACCESS_DENIED' });
  expect(store.finishRow).toHaveBeenCalledWith(site,id,actor,'succeeded');
  expect(executeConnectorTool).toHaveBeenCalledTimes(1);
});

test('an already pending support-member request cannot authorize an instance-only tool', async () => {
  auth.connector.toolkit_slug = 'supabase'; auth.connector.supabase_project_ref = 'a'.repeat(20);
  row.action = actionSnapshot({ kind: 'support_member', user_id: randomUUID() }, auth,
    { ...descriptor, slug: 'SUPABASE_LIST_TABLES', toolkitSlug: 'supabase', scopes: ['Database:Read'] }, {});
  expect(await listConnectorApprovals(site, actor)).toEqual({ items: [] });
  await expect(decide()).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
  expect(store.decideRow).not.toHaveBeenCalled();
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test.each(['before dispatch', 'after dispatch'])('changed support origin %s cannot release a private read', async when => {
  row.action.origin = { kind: 'support_member', user_id: randomUUID() };
  let sent = false;
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    if (when === 'before dispatch') jest.mocked(requireSupportOrigin).mockRejectedValue(denied());
    await input.beforeDispatch();
    sent = true;
    jest.mocked(requireSupportOrigin).mockRejectedValue(denied());
    return { successful: true, data: { count: 4 } };
  });
  await expect(decide()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(sent).toBe(when === 'after dispatch');
  expect(store.finishRow).toHaveBeenCalledWith(site, id, actor, sent ? 'succeeded' : 'failed');
  await expect(decide()).rejects.toThrow();
  expect(executeConnectorTool).toHaveBeenCalledTimes(1);
});

test('review uses requesting member/agent only to verify proposal eligibility; manager supplies executable authority', async () => {
  const owner = randomUUID();
  row.action.origin = {kind:'support_member',user_id:owner};
  jest.mocked(access.resolveConnectorAction).mockImplementation(async (ctx, _id, _slug, allowRequest) => {
    if (ctx.userId !== owner || ctx.agentId !== agent || !allowRequest) throw denied();
    return {...auth,requestOnly:true};
  });
  expect(await decide()).toMatchObject({status:'completed'});
  expect(access.resolveManagerAction).toHaveBeenCalledWith(site,actor,auth.connector.id,descriptor.slug);
});

test('legacy blind origin is not upgraded into a manager execution grant', async () => {
  row.action.origin = {kind:'conversation'};
  await expect(decide()).rejects.toThrow(); expect(store.decideRow).not.toHaveBeenCalled();
});
