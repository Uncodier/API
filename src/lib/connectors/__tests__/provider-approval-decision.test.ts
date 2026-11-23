import { randomUUID } from 'node:crypto';
import { decideConnectorApproval, listConnectorApprovals } from '../approval-decisions';
import { type ApprovalRow } from '../approval-action';
import { requireConversationAgent } from '../approval-proposals';
import * as store from '../approval-store';
import { reviewContext } from '../approval-context';
import { genericReviewTarget } from '../generic-review-target';
import { loadConnectorCredential } from '../access';
import type { DirectAuthorizedConnector } from '../provider-direct-policy';
import { describeDirectTool } from '../provider-direct-transport';
import { hashConnectorSchema } from '../composio-tool-json';
import { ConnectorError } from '../types';
import { accountFixture, connectorFixture, jsonResponse, providerFixture, secret, toolkitFixture, toolFixture } from './composio-fixtures';
import { attestedProject, byokOrigin } from './byok-rpc-fixture';

const mockRpc = jest.fn(), http = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock('../access', () => ({ requireConnectorSiteAccess: jest.fn(), loadConnectorCredential: jest.fn() }));
jest.mock('../approval-proposals', () => ({ requireConversationAgent: jest.fn() }));
jest.mock('../approval-context', () => ({ reviewContext: jest.fn() }));
jest.mock('../generic-review-target', () => ({ ...jest.requireActual('../generic-review-target'), genericReviewTarget: jest.fn() }));
jest.mock('../approval-store', () => ({ getApproval: jest.fn(), pendingRows: jest.fn(), decideRow: jest.fn(), finishRow: jest.fn() }));

const fetchBefore = global.fetch, originBefore = process.env.CONNECTORS_WEB_ORIGIN;
beforeEach(() => { jest.resetAllMocks(); global.fetch = http; process.env.CONNECTORS_WEB_ORIGIN = byokOrigin; });
afterEach(() => { global.fetch = fetchBefore; if (originBefore === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = originBefore; });
const denied = () => new ConnectorError('ACCESS_CHANGED', 'Not available.', 403);
async function fixture(bound = false, operation: 'GET_PROJECT' | 'LIST_TABLES' = 'GET_PROJECT') {
  const site = randomUUID(), agent = randomUUID(), actor = randomUUID(), id = randomUUID();
  const project='b'.repeat(20), kit = bound?'supabase':'orderdesk', slug = bound?`SUPABASE_${operation}`:'ORDERDESK_CREATE_ORDER';
  const refField=operation==='GET_PROJECT'?'ref':'project_ref';
  const expiry=new Date(Date.now()+60000).toISOString();
  const connector = { ...connectorFixture(), site_id: site, id: randomUUID(), toolkit_slug: kit };
  const provider = { ...providerFixture(), site_id: site, provider_user_id: site, credential_revision: secret() };
  const target:DirectAuthorizedConnector = { connector, provider, policy: { revision: 1, require_approval: true, allowed_hosts: ['assistant'],
    tool_access_mode: 'selected' as const, allowed_tools: [slug] }, directProof: { siteId: site, connectorId: connector.id,
    attestationId: randomUUID(), directRevision: 1, expiresAt: new Date(Date.now()+60000).toISOString(), providerId: provider.id,
    projectId: provider.project_id, toolkitSlug: kit, accountId: connector.provider_account_id, authConfigId: connector.auth_config_id,
    credentialRevision: provider.credential_revision, resourceBoundary: 'business-orders' } };
  if (bound) {
    const {directRevision,siteId,connectorId,providerId,toolkitSlug,projectId,accountId,authConfigId,credentialRevision}=target.directProof;
    target.directProof={kind:'connected_account',authorizationId:randomUUID(),authScheme:'API_KEY',boundProjectRef:project,
      directRevision,siteId,connectorId,providerId,toolkitSlug,projectId,accountId,authConfigId,credentialRevision};
    target.localProjectRef=target.connector.supabase_project_ref=project;
  }
  const credential = { source: 'byok' as const, apiKey: secret(), revision: provider.credential_revision };
  mockRpc.mockImplementation(attestedProject(provider));
  jest.mocked(loadConnectorCredential).mockResolvedValue(credential);
  const screens = { isAdmin: false, blockedScreens: ['billing'] };
  const access = { target, screens };
  jest.mocked(genericReviewTarget).mockResolvedValue(access);
  const tool = { ...toolFixture(), slug, toolkit: { slug: kit }, input_parameters: { type: 'object', properties: { quantity: { type: 'integer', minimum: 1 } } } };
  const account = { ...accountFixture(), user_id: site, toolkit: { slug: kit }, state: { authScheme: 'OAUTH2', val: { scope: 'orders' } } };
  if(bound) {
    Object.assign(tool,{tags:['readOnlyHint'],input_parameters:{type:'object',properties:{[refField]:{type:'string'}},required:[refField]}});
    Object.assign(account,{state:{authScheme:'API_KEY',val:{full:'https://api.supabase.com'}}});
  }
  const posts = jest.fn((_body: unknown) => jsonResponse({ successful: true, error: null, data: { customer: 'private business record', ...(bound && {id:project,ref:project}) } }));
  const onPrepare = jest.fn();
  http.mockImplementation(async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith(`/tools/${slug}`)) { onPrepare(); return jsonResponse(tool); }
    if (path.endsWith(`/toolkits/${kit}`)) return jsonResponse({ ...toolkitFixture(), slug: kit, enabled: true });
    if (path.endsWith(`/connected_accounts/${account.id}`)) return jsonResponse(account);
    if (path.endsWith(`/execute/${slug}`) && init.method === 'POST') return posts(JSON.parse(init.body));
    throw new Error('Unexpected request');
  });
  const d = await describeDirectTool(target, credential, slug);
  const row: ApprovalRow = { id, site_id: site, conversation_id: randomUUID(), agent_id: agent, created_at: new Date().toISOString(),
    expires_at: expiry, status: 'pending', actor_user_id: null, action: { execution: 'provider',
      origin: { kind: 'channel_public', lead_id: null }, connector_id: connector.id, account_label: connector.display_name,
      tool_slug: slug, version: d.version, schema_hash: d.schemaHash, binding: hashConnectorSchema(target), scopes: [], arguments: bound ? {} : { quantity: 2 } } };
  jest.mocked(store.pendingRows).mockResolvedValue([row]);
  jest.mocked(store.getApproval).mockResolvedValue(row);
  jest.mocked(store.decideRow).mockImplementation(async (_site, _id, user, decision) => {
    if (row.status !== 'pending') throw denied();
    row.status = decision === 'approve' ? 'executing' : 'rejected'; row.actor_user_id = user; return row;
  });
  return { target, actor, access, site, agent, row, posts, onPrepare, list: () => listConnectorApprovals(site, actor),
    decide: (decision: 'approve'|'reject' = 'approve') => decideConnectorApproval(site, id, actor, decision) };
}

test('list and race two reviews of a newly issued public write: only the winning manager dispatches, no provider result', async () => {
  const { target, actor, access, site, agent, row, posts, list, decide } = await fixture();
  expect((await list()).items).toEqual([expect.objectContaining({ connector_id: target.connector.id, arguments: { quantity: 2 } })]);
  expect(reviewContext).toHaveBeenCalledWith(undefined, row, row.action, access.screens);
  expect(posts).not.toHaveBeenCalled();
  const results = await Promise.allSettled([decide(), decide()]);
  expect(results.filter(r => r.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: { id: row.id, status: 'completed', result_omitted: true } }]);
  expect(posts.mock.calls).toEqual([[{ connected_account_id: target.connector.provider_account_id, user_id: site, version: row.action.version, arguments: { quantity: 2 } }]]);
  expect(genericReviewTarget).toHaveBeenCalledWith(site, agent, target.connector.id, row.action.tool_slug, actor, 'reviewer');
  expect(requireConversationAgent).toHaveBeenCalledWith(site, row.conversation_id, agent, row.action.origin);
  expect(store.finishRow).toHaveBeenCalledWith(site, row.id, actor, 'succeeded');
});

test.each(['binding', 'account', 'revision', 'agent', 'origin member', 'manager', 'conversation', 'policy', 'screens', 'schema', 'version', 'args', 'raw SQL', 'unsupported origin'])('hides and denies stale or unsupported %s before claiming', async reason => {
  const { row, target, access, list, decide, posts } = await fixture();
  if (reason === 'binding') row.action.binding = secret();
  if (reason === 'account') row.action.connector_id = randomUUID();
  if (reason === 'revision') target.directProof.directRevision++;
  if (reason === 'agent' || reason === 'manager') jest.mocked(genericReviewTarget).mockRejectedValue(denied());
  if (reason === 'origin member') {
    const member = randomUUID(); row.action.origin = { kind: 'channel_member', user_id: member };
    jest.mocked(genericReviewTarget).mockImplementation(async (...args) => { if (args[4] === member) throw denied(); return access; });
  }
  if (reason === 'conversation') jest.mocked(requireConversationAgent).mockRejectedValue(denied());
  if (reason === 'policy') { target.policy.require_approval = false; row.action.binding = hashConnectorSchema(target); }
  if (reason === 'screens') jest.mocked(genericReviewTarget).mockResolvedValue({ target, screens: null });
  if (reason === 'schema') row.action.schema_hash = secret();
  if (reason === 'version') row.action.version = '20261119_01';
  if (reason === 'args') row.action.arguments = { quantity: -1 };
  if (reason === 'raw SQL') row.action.tool_slug = 'ORDERDESK_EXECUTE_SQL';
  if (reason === 'unsupported origin') row.action.origin = { kind: 'conversation' };
  expect(await list()).toEqual({ items: [] });
  await expect(decide()).rejects.toThrow(); expect(store.decideRow).not.toHaveBeenCalled(); expect(posts).not.toHaveBeenCalled();
});

test('rejection has no dispatch or grant', async () => {
  const { decide, row, posts } = await fixture();
  expect(await decide('reject')).toEqual({ id: row.id, status: 'rejected' });
  expect(posts).not.toHaveBeenCalled(); expect(store.finishRow).not.toHaveBeenCalled();
});

test.each(['before dispatch', 'after dispatch'])('revocation %s cannot release a result or grant a retry', async timing => {
  const { row, decide, posts, onPrepare } = await fixture();
  let prepares = 0;
  if (timing === 'before dispatch') onPrepare.mockImplementation(() => {
    if (row.status === 'executing' && ++prepares === 2) jest.mocked(requireConversationAgent).mockRejectedValue(denied());
  });
  else posts.mockImplementation(() => {
    jest.mocked(genericReviewTarget).mockRejectedValue(denied());
    return jsonResponse({ successful: true, error: null, data: { count: 10 } });
  });
  await expect(decide()).rejects.toThrow(); await expect(decide()).rejects.toThrow();
  expect(posts).toHaveBeenCalledTimes(timing === 'before dispatch' ? 0 : 1);
  expect(store.finishRow).toHaveBeenCalledWith(row.site_id, row.id, row.actor_user_id, timing === 'before dispatch' ? 'failed' : 'succeeded');
});

test('a manager review of shared project metadata cannot replace its project or described action, or return downstream data',async()=>{
  const {row,target,site,posts,list,decide}=await fixture(true);
  row.action.arguments={ref:'c'.repeat(20)};
  expect((await list()).items).toEqual([]);await expect(decide()).rejects.toThrow();
  row.action.arguments={};const original=row.action.tool_slug;
  for(const slug of ['SUPABASE_LIST_PROJECTS','SUPABASE_SELECT_FROM_TABLE','SUPABASE_EXECUTE_SQL']) {
    row.action.tool_slug=slug;target.policy.allowed_tools=[slug];row.action.binding=hashConnectorSchema(target);
    await expect(decide()).rejects.toThrow();
  }
  expect(store.decideRow).not.toHaveBeenCalled();expect(posts).not.toHaveBeenCalled();
  row.action.tool_slug=original;target.policy.allowed_tools=[original];row.action.binding=hashConnectorSchema(target);
  expect((await list()).items).toHaveLength(1);
  await expect(decide()).resolves.toEqual({id:row.id,status:'completed',result_omitted:true});
  expect(posts.mock.calls).toEqual([[{connected_account_id:target.connector.provider_account_id,user_id:site,
    version:row.action.version,arguments:{ref:target.connector.supabase_project_ref}}]]);
});

test('a manager can approve a selected table-listing action on the shared project without releasing the result',async()=>{
  const {row,target,site,agent,actor,posts,list,decide}=await fixture(true,'LIST_TABLES');
  expect((await list()).items).toHaveLength(1);
  expect(posts).not.toHaveBeenCalled();
  await expect(decide()).resolves.toEqual({id:row.id,status:'completed',result_omitted:true});
  expect(genericReviewTarget).toHaveBeenCalledWith(site,agent,target.connector.id,'SUPABASE_LIST_TABLES',actor,'reviewer');
  expect(posts.mock.calls).toEqual([[{connected_account_id:target.connector.provider_account_id,user_id:site,
    version:row.action.version,arguments:{project_ref:target.connector.supabase_project_ref}}]]);
});
