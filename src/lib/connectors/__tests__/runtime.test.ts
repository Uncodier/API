import { randomBytes, randomUUID } from 'node:crypto';
import { createConnectorRuntime } from '../runtime';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from '../types';
import { resolveConnectorAction, listUsableConnectors, loadConnectorCredential } from '../access';
import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';

const mockRpc = jest.fn();
const receiptId = randomUUID();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock('../access', () => ({ resolveConnectorAction: jest.fn(), listUsableConnectors: jest.fn(), loadConnectorCredential: jest.fn() }));
jest.mock('../composio-sessions', () => ({ describeConnectorTool: jest.fn(), executeConnectorTool: jest.fn() }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'), loadToolScreenAccess: jest.fn(),
}));

const context: ConnectorContext = { siteId: randomUUID(), userId: randomUUID(), agentId: randomUUID(), instanceId: randomUUID(), catalogUserSession: true as const, host: 'assistant' };
const connectorId = randomUUID();
const name = `connector:${connectorId}:HUBSPOT_LIST_CONTACTS`;
let authorized: AuthorizedConnector;
const descriptor = { slug: 'HUBSPOT_LIST_CONTACTS', toolkitSlug: 'hubspot', toolkitVersion: '20261119_01',
  schemaHash: randomBytes(32).toString('hex'), description: 'Untrusted provider prose', scopes: ['crm.objects.contacts.read'], scopeRequirements: null,
  inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } };
const envelope = () => ({ version: descriptor.toolkitVersion, schema_hash: descriptor.schemaHash, arguments: { limit: 5 } });

beforeEach(() => {
  jest.resetAllMocks();
  mockRpc.mockImplementation(name => ({ abortSignal: async () => ({ data: name === 'connector_private_result_ready' ? true : receiptId, error: null }) }));
  authorized = { connector: { id: connectorId, site_id: context.siteId, provider_id: randomUUID(),
    provider_project_id: 'project-test', toolkit_slug: 'hubspot', provider_account_id: 'account-sales', auth_config_id: 'auth-test',
    display_name: 'Private account label', provider_status: 'ACTIVE', enabled: true, revocation_pending: false,
    granted_scopes: ['crm.objects.contacts.read'], created_by: context.userId, revision: 1, verified_at: new Date().toISOString() },
    provider: { id: '', site_id: context.siteId, provider: 'composio', project_id: 'project-test', provider_user_id: 'site-test', credential_revision: 'revision', status: 'active' },
    policy: { allowed_tools: [descriptor.slug], allowed_hosts: ['assistant'], require_approval: false, revision: 1 } };
  authorized.provider.id = authorized.connector.provider_id;
  jest.mocked(resolveConnectorAction).mockImplementation(async () => structuredClone(authorized));
  jest.mocked(listUsableConnectors).mockImplementation(async () => [structuredClone(authorized)]);
  jest.mocked(loadConnectorCredential).mockResolvedValue({ apiKey: randomBytes(24).toString('hex'), revision: 'revision', source: 'byok' });
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: [] });
  jest.mocked(describeConnectorTool).mockResolvedValue(descriptor);
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    await input.beforeDispatch();
    return { successful: true, data: input.catalogRead ? { items: [{ name: 'Private inventory' }] } : { contacts: [{ id: '12', properties: { firstname: 'Private Contact', notes: 'discarded' } }] }, logId: 'log-test' };
  });
});

test('search is local, concrete, bounded, and never exposes account labels or full schemas', async () => {
  const runtime = createConnectorRuntime(async () => context);
  const result = await runtime.search({ query: 'CRM contacts', domain: 'crm', category: 'crm' });
  expect(result.tools).toEqual([expect.objectContaining({ name, availability: 'describe_required' })]);
  expect(JSON.stringify(result)).not.toContain('Private account label');
  expect(JSON.stringify(result)).not.toContain('inputSchema');
  expect(describeConnectorTool).not.toHaveBeenCalled();
  expect(executeConnectorTool).not.toHaveBeenCalled();
  expect((await runtime.search({ domain: 'calendar' })).tools).toEqual([]);
});

test('all granted accounts remain reachable through scoped pagination or an exact account filter', async () => {
  const accounts = Array.from({ length: 7 }, () => ({ ...structuredClone(authorized), connector: { ...structuredClone(authorized.connector), id: randomUUID() } }));
  jest.mocked(listUsableConnectors).mockResolvedValue(accounts);
  const runtime = createConnectorRuntime(async () => context);
  const first = await runtime.search({ domain: 'crm' });
  expect(first.tools).toHaveLength(5); expect(first.next_cursor).toBeTruthy();
  const second = await runtime.search({ domain: 'crm', cursor: first.next_cursor! });
  expect(second.tools).toHaveLength(2); expect(second.next_cursor).toBeNull();
  expect(new Set([...first.tools, ...second.tools].map(tool => tool.connector_id)).size).toBe(7);
  const last = accounts[6].connector.id;
  expect((await runtime.search({ connector_id: last })).tools.map(tool => tool.connector_id)).toEqual([last]);
  await expect(runtime.search({ domain: 'communication', cursor: first.next_cursor! })).rejects.toMatchObject({ code: 'STALE_CURSOR' });
});

test('exact description envelope survives a new runtime/turn and rechecks the descriptor', async () => {
  const description = await createConnectorRuntime(async () => context).describe(name);
  expect(description.description).not.toBe(descriptor.description);
  expect(description.parameters.properties.arguments).toEqual(descriptor.inputSchema);
  const result = await createConnectorRuntime(async () => context).call(name, envelope());
  expect('receipt' in result && result.receipt).toEqual({ status: 'private_result_ready', url: `/connectors/results/${receiptId}` });
  expect(JSON.stringify(result)).not.toMatch(/Private Contact|discarded|log-test|contacts/i);
  expect(mockRpc).toHaveBeenCalledWith('store_connector_private_result', expect.objectContaining({ p_user_id: context.userId, p_agent_id: context.agentId, p_report: expect.objectContaining({ rows: [['12', 'Private Contact', '']] }) }));
  expect(describeConnectorTool).toHaveBeenLastCalledWith(expect.objectContaining({ toolkitVersion: descriptor.toolkitVersion }));
  expect(executeConnectorTool).toHaveBeenCalledWith(expect.objectContaining({ connector: expect.objectContaining({ provider_account_id: 'account-sales' }),
    toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, allowedTools: [descriptor.slug], input: { limit: 5 },
    requiredScopes: ['crm.objects.contacts.read'] }));
  expect(resolveConnectorAction).toHaveBeenCalledWith(context, connectorId, descriptor.slug, false);
});

test.each(['connectors', 'people', 'leads'])('required screen %s blocks members in search/describe/call', async screen => {
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: [screen] });
  const runtime = createConnectorRuntime(async () => context);
  expect((await runtime.search()).tools).toEqual([]);
  await expect(runtime.describe(name)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await expect(runtime.call(name, envelope())).rejects.toMatchObject({ code: 'ACCESS_DENIED', executed: false });
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test.each(['member revoked', 'agent revoked', 'approval required', 'connector disabled'])('fresh access failure: %s', async () => {
  const runtime = createConnectorRuntime(async () => context);
  await runtime.describe(name);
  jest.mocked(resolveConnectorAction).mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied', 403));
  await expect(runtime.call(name, envelope())).rejects.toMatchObject({ executed: false });
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('revocation during provider preparation fails the final callback', async () => {
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    authorized.policy.allowed_tools = [];
    await input.beforeDispatch();
    throw new Error('Must not dispatch');
  });
  await expect(createConnectorRuntime(async () => context).call(name, envelope())).rejects.toMatchObject({ code: 'ACCESS_CHANGED', effectStarted: false });
});

test('changed agent binding during provider preparation is not treated as direct human', async () => {
  let current = context;
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    current = { ...context, agentId: randomUUID() };
    await input.beforeDispatch();
    throw new Error('Must not dispatch');
  });
  await expect(createConnectorRuntime(async () => current).call(name, envelope())).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
});

test.each([{ host: 'workflow' as const }, { agentId: undefined }])('unsupported host or missing agent blocks', async patch => {
  const runtime = createConnectorRuntime(async () => ({ ...context, ...patch }));
  await expect(runtime.search()).rejects.toMatchObject({ code: 'HOST_DISABLED' });
  await expect(runtime.call(name, envelope())).rejects.toMatchObject({ code: 'HOST_DISABLED' });
  expect(resolveConnectorAction).not.toHaveBeenCalled();
});

test('schema fingerprint drift and unsafe arguments stop before execute', async () => {
  const runtime = createConnectorRuntime(async () => context);
  await expect(runtime.call(name, { ...envelope(), schema_hash: randomBytes(32).toString('hex') })).rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  await expect(runtime.call(name, { ...envelope(), arguments: { limit: 1001 } })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
  await expect(runtime.call(name, { ...envelope(), arguments: { connected_account_id: 'account-executive' } })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('credential rotation and unknown action never dispatch', async () => {
  jest.mocked(loadConnectorCredential).mockResolvedValue({ apiKey: randomBytes(24).toString('hex'), revision: 'rotated', source: 'byok' });
  const runtime = createConnectorRuntime(async () => context);
  await expect(runtime.describe(name)).rejects.toMatchObject({ code: 'STALE_CREDENTIAL' });
  await expect(runtime.call(name.replace(descriptor.slug, 'HUBSPOT_DELETE_CONTACT'), envelope())).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED' });
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('a saved catalogue-only action remains undiscoverable and nonexecutable', async () => {
  const slug = 'HUBSPOT_DELETE_CONTACT';
  authorized.policy.allowed_tools = [slug];
  const runtime = createConnectorRuntime(async () => context);
  const reference = `connector:${connectorId}:${slug}`;
  expect((await runtime.search({ query: 'delete contacts' })).tools).toEqual([]);
  await expect(runtime.describe(reference)).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED' });
  await expect(runtime.call(reference, envelope())).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED' });
  expect(describeConnectorTool).not.toHaveBeenCalled();
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('an error after dispatch does not claim no effect', async () => {
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    await input.beforeDispatch();
    throw new ConnectorError('UPSTREAM_FAILURE', 'Provider unavailable.', 502);
  });
  await expect(createConnectorRuntime(async () => context).call(name, envelope())).rejects.not.toHaveProperty('executed');
});
test('require approval proposes reviewed envelope without calling provider, client approval flags rejected', async () => {
  authorized.policy.require_approval = true;
  authorized.requestOnly = true;
  const runtime = createConnectorRuntime(async () => ({ ...context, requestId: randomUUID() }));
  await expect(runtime.call(name, { ...envelope(), approved: true })).rejects.toMatchObject({ executed: false });
  const requestId = randomUUID();
  const bound = createConnectorRuntime(async () => ({ ...context, requestId }));
  const propose = jest.spyOn(await import('../approval-proposals'), 'proposeInteractiveConnectorAction').mockResolvedValue({ status: 'pending' });
  try {
    expect(await bound.call(name, envelope())).toEqual({ success: true, status: 'pending' });
    expect(propose).toHaveBeenCalledWith({ ...context, requestId }, authorized, descriptor, envelope().arguments);
    expect(executeConnectorTool).not.toHaveBeenCalled();
  } finally { propose.mockRestore(); }
});

test('the request setting does not gate direct authorized use, but losing use withholds the result', async () => {
  authorized.policy.require_approval = true;
  const runtime = createConnectorRuntime(async () => ({ ...context, requestId: context.instanceId }));
  expect(await runtime.describe(name)).toMatchObject({require_approval:false});
  expect(await runtime.call(name, envelope())).toMatchObject({receipt:{status:'private_result_ready'}});
  jest.mocked(executeConnectorTool).mockImplementation(async target => {
    await target.beforeDispatch(); authorized.requestOnly = true;
    return {successful:true,data:{secret:'not released'},logId:undefined};
  });
  await expect(runtime.call(name, envelope())).rejects.toMatchObject({code:'ACCESS_CHANGED'});
});

test('instance catalog read pins the exact connection and never releases data after permission loss', async () => {
  const slug='BOOKS_LIST_EDITIONS'; const ref=`connector:${connectorId}:${slug}`;
  authorized.connector.toolkit_slug='books'; Object.assign(authorized.policy,{catalog_reads:true,tool_access_mode:'all'});
  const safeSchema = {type:'object',properties:{limit:{type:'integer',minimum:1,maximum:25}},required:['limit']};
  jest.mocked(describeConnectorTool).mockResolvedValue({...descriptor, slug, toolkitSlug:'books',catalogModelSchema:safeSchema, description:'List editions with bounded output.'});
  const runtime=createConnectorRuntime(async () => context);
  const description=await runtime.describe(ref);
  expect(description.parameters.properties.arguments).toEqual(safeSchema);
  expect(resolveConnectorAction).toHaveBeenCalledWith(context,connectorId,slug,false,true);
  const out = await runtime.call(ref,envelope());
  expect(out).toMatchObject({receipt:{status:'private_result_ready'}}); expect(JSON.stringify(out)).not.toContain('Private inventory');
  expect(executeConnectorTool).toHaveBeenCalledWith(expect.objectContaining({catalogRead:true, toolkitVersion:description.version,schemaHash:description.schema_hash}));
  expect(describeConnectorTool).toHaveBeenCalledTimes(1); // execute adapter verifies pinned metadata without a redundant preliminary descriptor
  jest.mocked(executeConnectorTool).mockImplementation(async options=>{
    await options.beforeDispatch(); authorized.policy.catalog_reads=false; return {successful:true,data:{withheld:true},logId:undefined};
  });
  await expect(runtime.call(ref,envelope())).rejects.not.toHaveProperty('executed');
  jest.mocked(executeConnectorTool).mockClear();
  await expect(runtime.call(ref,envelope())).rejects.toMatchObject({executed:false});
  expect(executeConnectorTool).not.toHaveBeenCalled();
});


test('a preflight marker from a failed result-release check cannot erase a previous dispatch', async () => {
  jest.mocked(executeConnectorTool).mockImplementation(async input=>{
    await input.beforeDispatch();
    jest.mocked(resolveConnectorAction).mockRejectedValueOnce(Object.assign(new ConnectorError('ACCESS_DENIED','Denied'),{executed:false,effectStarted:false}));
    return {successful:true,data:{withheld:true},logId:undefined};
  });
  const error=await createConnectorRuntime(async()=>context).call(name,envelope()).catch(e=>e);
  expect(error.code).toBe('ACCESS_DENIED'); expect(error).not.toHaveProperty('executed'); expect(error).not.toHaveProperty('effectStarted');
});


test('a legacy or recovered assistant has no raw-envelope fallback; no dispatch without a verified private destination', async () => {
  for (const ctx of [{ ...context, catalogUserSession: undefined }, { ...context, instanceId: undefined }]) {
    await expect(createConnectorRuntime(async () => ctx).call(name, envelope())).rejects.toMatchObject({ code:'PRIVATE_DESTINATION_REQUIRED', executed:false });
  }
  expect(executeConnectorTool).not.toHaveBeenCalled();
  mockRpc.mockReturnValue({ abortSignal: async () => ({ data:false, error:null }) });
  await expect(createConnectorRuntime(async () => context).call(name, envelope())).rejects.toMatchObject({ code:'ACCESS_DENIED', executed:false });
  expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['connector_private_result_ready']);
});

test('when private persistence fails after dispatch, do not fall back to exposing result, partial receipt or DB diagnostics', async () => {
  mockRpc.mockImplementation(name => ({ abortSignal: async () => name === 'connector_private_result_ready' ? { data:true } :
    { data:null, error:{ message:'Private Contact', hint:'discarded', code:'42501' } } }));
  const error = await createConnectorRuntime(async () => context).call(name, envelope()).catch(e => e);
  expect(error.code).toBe('ACCESS_CHANGED'); expect(String(error)).not.toMatch(/Private Contact|discarded/);
  expect(error).not.toHaveProperty('receipt'); expect(error).not.toHaveProperty('executed');
});


test.each(['rejected', 'resolved', 'invalid receipt'])('after a successful read: handles %s private store failure as unconfirmed delivery without leaking or retrying', async mode => {
  mockRpc.mockImplementation(name => ({ abortSignal: async () => {
    if(name === 'connector_private_result_ready') return {data:true};
    if(mode === 'rejected') throw new Error('Private Contact');
    return mode === 'resolved' ? {data:null,error:{message:'Private Contact'}} : {data:'Private Contact'};
  }}));
  const error = await createConnectorRuntime(async () => context).call(name,envelope()).catch(e=>e);
  const { failureForAgent } = await import('../agent-recovery'); const recovery = failureForAgent(error);
  expect(recovery).toMatchObject({code:'PRIVATE_DELIVERY_UNCONFIRMED',automatic_retry:false,recovery:{action:'reconcile'}});
  expect(recovery).not.toHaveProperty('executed'); expect(recovery.error).toContain('Private reports');
  expect(JSON.stringify(recovery)).not.toContain('Private Contact'); expect(executeConnectorTool).toHaveBeenCalledTimes(1);
});
