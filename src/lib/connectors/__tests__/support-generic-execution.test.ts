import {randomUUID} from 'node:crypto';
import {executeGenericSupport} from '../support-generic-execution';
import {authorizeGenericSupport} from '../support-generic-authority';
import {loadConnectorCredential} from '../account-access';
import {sourceDigest} from '../approval-source';
import {accountFixture, connectorFixture, jsonResponse, providerFixture, secret, toolFixture, toolkitFixture} from './composio-fixtures';
import {attestedProject, byokOrigin} from './byok-rpc-fixture';

const mockRpc = jest.fn(), http = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin: {rpc: (...args: unknown[]) => mockRpc(...args)}}));
jest.mock('../support-generic-authority', () => ({authorizeGenericSupport: jest.fn()}));
jest.mock('../account-access', () => ({loadConnectorCredential: jest.fn()}));
const fetchBefore = global.fetch, originBefore = process.env.CONNECTORS_WEB_ORIGIN;
beforeEach(() => {jest.resetAllMocks(); global.fetch = http; process.env.CONNECTORS_WEB_ORIGIN = byokOrigin;});
afterEach(() => {global.fetch = fetchBefore; if (originBefore === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = originBefore;});

function fixture(entitled = true) {
  const siteId = randomUUID(), scope = {audience: 'member' as const, siteId, agentId: randomUUID(), conversationId: randomUUID(), userId: randomUUID(), idempotencyKey: randomUUID()};
  const kit = 'orderdesk', slug = 'ORDERDESK_SEARCH_ORDERS', connector = {...connectorFixture(), site_id: siteId, id: randomUUID(), toolkit_slug: kit};
  const provider = {...providerFixture(), site_id: siteId, provider_user_id: siteId, credential_revision: secret()};
  const target = {connector, provider, policy: {revision: 2, require_approval: false, allowed_hosts: ['assistant'], tool_access_mode: 'selected' as const, allowed_tools: [slug]},
    directProof: {siteId, connectorId: connector.id, attestationId: randomUUID(), directRevision: 5, expiresAt: new Date(Date.now()+60000).toISOString(),
      providerId: provider.id, projectId: provider.project_id, toolkitSlug: kit, accountId: connector.provider_account_id, authConfigId: connector.auth_config_id,
      credentialRevision: provider.credential_revision, resourceBoundary: 'isolated-business'}};
  const access = {target, releaseMemberResult: entitled}, apiKey = secret();
  jest.mocked(authorizeGenericSupport).mockResolvedValue(access);
  jest.mocked(loadConnectorCredential).mockResolvedValue({source: 'byok', apiKey, revision: provider.credential_revision});
  const name = `connector:${connector.id}:${slug}`;
  const tool = {...toolFixture(), toolkit: {slug: kit}, slug, input_parameters: {type: 'object', properties: {limit: {type: 'integer', maximum: 10}}}};
  const toolkit = {...toolkitFixture(), slug: kit, enabled: true};
  const account = {...accountFixture(), user_id: siteId, toolkit: {slug: kit}, state: {authScheme: 'OAUTH2', val: {scope: 'email.read'}}};
  const claims: unknown[] = [], posts: unknown[] = [];
  const claim = jest.fn().mockResolvedValueOnce({data: true, error: null}).mockResolvedValue({data: false, error: null});
  mockRpc.mockImplementation((rpc, args) => rpc === 'connector_claim_support_dispatch' ? {abortSignal: () => {claims.push(args); return claim();}} : attestedProject(provider)(rpc, args));
  const data: Record<string,unknown> = {count: 3, has_more: false, token: apiKey, records: [{body: 'private customer record'}]};
  const dispatch = jest.fn().mockImplementation(() => jsonResponse({successful: true, error: null, data}));
  http.mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith(`/tools/${slug}`)) return jsonResponse(tool);
    if (path.endsWith(`/toolkits/${kit}`)) return jsonResponse(toolkit);
    if (path.endsWith(`/connected_accounts/${account.id}`)) return jsonResponse(account);
    if (path.endsWith(`/execute/${slug}`) && options.method === 'POST') {posts.push(JSON.parse(options.body)); return dispatch();}
    throw new Error('Unexpected outbound request');
  });
  const host = jest.fn(async () => {});
  const describe = () => executeGenericSupport(scope, {action: 'describe', name}, host);
  const pin = async () => {
    const d = await describe();
    if (!('schema_hash' in d) || !d.schema_hash || !d.version) throw new Error('No description');
    return {action: 'call' as const, name, schema_hash: d.schema_hash, version: d.version, arguments: {limit: 4}};
  };
  return {scope, name, slug, host, target, access, apiKey, claims, claim, posts, dispatch, data, pin, describe,
    call: (p: Awaited<ReturnType<typeof pin>>) => executeGenericSupport(scope, p, host)};
}

it('describes and executes one pinned action on the exact agent-authorized site account; returns only confirmed scalar facts', async () => {
  const f = fixture(), p = await f.pin();
  expect(f.claims).toEqual([]);
  expect(await f.call(p)).toEqual({success: true, status: 'completed', result: {count: 3, has_more: false}});
  expect(f.posts).toEqual([{connected_account_id: f.target.connector.provider_account_id, user_id: f.scope.siteId, version: p.version, arguments: p.arguments}]);
  expect(f.claims).toEqual([{p_site_id: f.scope.siteId, p_agent_id: f.scope.agentId, p_conversation_id: f.scope.conversationId, p_user_id: f.scope.userId,
    p_connector_id: f.target.connector.id, p_slug: f.slug, p_turn_digest: sourceDigest(f.scope.idempotencyKey)}]);
  expect(authorizeGenericSupport).toHaveBeenCalledWith(f.scope, f.target.connector.id, f.slug);
  // Same trusted turn: changing model arguments must not reopen the claim.
  expect(await f.call({...p, arguments: {limit: 8}})).toMatchObject({success: false, automatic_retry: false});
  expect(f.posts).toHaveLength(1); expect(f.claims[0]).toEqual(f.claims[1]);
});
it('never reserves or posts a tool for a view-only member, even with a previously valid pin',async()=>{
  const f=fixture(),pin=await f.pin();jest.mocked(authorizeGenericSupport).mockResolvedValue({...f.access,releaseMemberResult:false});
  expect(await f.call(pin)).toMatchObject({success:false,status:'unavailable'});expect(f.claims).toEqual([]);expect(f.posts).toEqual([]);
});
it('omits unsupported output after an authorized call',async()=>{
  const f=fixture();Object.assign(f.data,{count:'3',has_more:[],total:-1,total_count:Number.MAX_SAFE_INTEGER+1});
  expect(await f.call(await f.pin())).toEqual({success:true,status:'completed',result_omitted:true});
});
it.each(['pin','arguments','credential','account','revoked','host','claim failure'])('does not dispatch with invalid %s', async reason => {
  const f = fixture(), p = await f.pin();
  if (reason === 'pin') p.schema_hash = secret();
  if (reason === 'arguments') p.arguments.limit = 11;
  if (reason === 'credential') jest.mocked(loadConnectorCredential).mockResolvedValue({source: 'platform', apiKey: secret(), revision: `platform:${secret()}`});
  if (reason === 'account') f.target.connector.id = randomUUID();
  if (reason === 'revoked') jest.mocked(authorizeGenericSupport).mockResolvedValueOnce(f.access).mockRejectedValueOnce(new Error(f.apiKey));
  if (reason === 'host') f.host.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(f.apiKey));
  if (reason === 'claim failure') f.claim.mockReset().mockRejectedValueOnce(new Error(f.apiKey));
  const result = await f.call(p); expect(result).toMatchObject({success: false, status: 'unavailable'});
  expect(JSON.stringify(result)).not.toContain(f.apiKey); expect(f.posts).toHaveLength(0);
  expect(f.claims).toHaveLength(reason === 'claim failure' ? 1 : 0);
});
it.each(['anonymous','verified'])('refuses %s before provider or authorization lookup', async audience => {
  const f = fixture(), {userId: _userId, ...base} = f.scope;
  const forged = {...base, audience, ...(audience === 'verified' && {leadId: randomUUID()})};
  expect(await executeGenericSupport(forged as typeof f.scope, {action: 'describe', name: f.name}, f.host)).toEqual({success: false, status: 'unavailable'});
  expect(http).not.toHaveBeenCalled(); expect(authorizeGenericSupport).not.toHaveBeenCalled();
});
it('withholds the response when output entitlement changes during dispatch', async () => {
  const f = fixture(), p = await f.pin();
  jest.mocked(authorizeGenericSupport).mockResolvedValueOnce(f.access).mockResolvedValueOnce(f.access).mockResolvedValue({...f.access, releaseMemberResult: false});
  expect(await f.call(p)).toEqual({success: false, status: 'outcome_unconfirmed', automatic_retry: false}); expect(f.posts).toHaveLength(1);
});
it('returns a confirmed app denial, never provider diagnostics or raw payload', async () => {
  const f = fixture(), p = await f.pin();
  f.dispatch.mockReturnValueOnce(jsonResponse({successful: false, error: f.apiKey, data: {status_code: 403, ...f.data}}));
  expect(await f.call(p)).toEqual({success: false, status: 'provider_denied', code: 'APP_RESOURCE_DENIED', automatic_retry: false});
});
it('treats an explicit HTTP 403 from dispatch as a final provider denial', async () => {
  const f = fixture(), p = await f.pin();
  f.dispatch.mockReturnValueOnce(jsonResponse({error: f.apiKey}, 403));
  expect(await f.call(p)).toEqual({success: false, status: 'provider_denied', code: 'PROVIDER_FORBIDDEN', automatic_retry: false});
  expect(f.posts).toHaveLength(1);
});
