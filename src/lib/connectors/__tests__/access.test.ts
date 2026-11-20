import { createHash, randomBytes } from 'node:crypto';
import { authorizeConnectorExecution, resolveManagerAction, getVisibleConnector, listUsableConnectors, listVisibleConnectors, requireConnectorSiteAccess } from '../access';
import type { ConnectorAccessMode } from '../types';
import { createConnectorRuntime } from '../runtime';
import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';

const rpc = jest.fn();
const from = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...args), from: (...args: unknown[]) => from(...args) } }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: () => 'synthetic' }));
jest.mock('../composio-sessions', () => ({ describeConnectorTool: jest.fn(), executeConnectorTool: jest.fn() }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  canUseToolScreen: () => true, loadToolScreenAccess: async () => ({ isAdmin: false, blockedScreens: [] }),
}));

const siteId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const connectorId = '44444444-4444-4444-8444-444444444444';
const ciphertext = randomBytes(48).toString('hex');
let tableData: Record<string, unknown>;
let connector: Record<string, unknown> & { id: string; access_mode?: ConnectorAccessMode };

function query(data: unknown, error: unknown = null, count = Array.isArray(data) ? data.length : null) {
  const value: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error, count }).then(resolve) };
  for (const name of ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'abortSignal']) value[name] = jest.fn(() => value);
  return value;
}

beforeEach(() => {
  jest.clearAllMocks();
  connector = { id: connectorId, site_id: siteId, provider_id: siteId, toolkit_slug: 'gmail', provider_status: 'ACTIVE', enabled: true, revocation_pending: false };
  rpc.mockImplementation((name, args) => name === 'connector_list_visible'
    ? query(args.p_connector_id == null ? [connector] : args.p_connector_id === connectorId ? connector : null)
    : query([{ can_view: true, can_manage: true }]));
  tableData = {
    connector_members: { user_id: userId, can_view: true, can_use: true, expires_at: null },
    connector_agents: { agent_id: agentId, enabled: true, expires_at: null },
    agents: { id: agentId },
    connector_policies: { allowed_tools: ['GMAIL_FETCH_EMAILS'], allowed_hosts: ['assistant'], require_approval: false },
    site_connector_providers: { id: siteId, site_id: siteId, status: 'active', credential_revision: createHash('sha256').update(ciphertext).digest('hex') },
    site_secrets: { encrypted_value: ciphertext },
  };
  from.mockImplementation(table => query(tableData[table]));
});

const context = { siteId, userId, agentId, host: 'assistant' as const };

it('rechecks effective site permissions and fails closed on storage outage', async () => {
  rpc.mockImplementationOnce(() => query([{ can_view: false, can_manage: false }]));
  await expect(requireConnectorSiteAccess(siteId, userId)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  rpc.mockImplementationOnce(() => query(null, { code: 'offline' }));
  await expect(requireConnectorSiteAccess(siteId, userId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(from).not.toHaveBeenCalled();
});

it('does not turn manager visibility into an execution grant', async () => {
  tableData.connector_members = null;
  expect(await listVisibleConnectors(siteId, userId)).toHaveLength(1);
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it.each(['connector_members', 'connector_agents'])('requires both member and agent grants (%s)', async table => {
  tableData[table] = null;
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it('rejects absent agent identity and unsupported background delegation', async () => {
  await expect(authorizeConnectorExecution({ ...context, agentId: undefined }, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
  await expect(authorizeConnectorExecution({ ...context, host: 'workflow' }, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'HOST_DISABLED' });
});

it('checks exact tool policy, account state, expiry and credential revision', async () => {
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_SEND_EMAIL')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  tableData.connector_members = { can_view: true, can_use: true, expires_at: '2000-01-01T00:00:00Z' };
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  tableData.connector_members = { can_view: true, can_use: true, expires_at: null };
  (tableData.site_connector_providers as any).credential_revision = 'changed';
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'PROVIDER_REVALIDATION_REQUIRED' });
});

it('does not fake approval or hide infrastructure errors as empty discovery', async () => {
  (tableData.connector_policies as any).require_approval = true;
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).resolves.toMatchObject({ connector: {id:connectorId} });
  expect(await listUsableConnectors(context)).toHaveLength(1); // Fully granted even when requests are enabled.
  rpc.mockImplementationOnce(() => query(null, { code: 'offline' }));
  await expect(listUsableConnectors(context)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});

it('returns the bound connector, policy and provider after all checks', async () => {
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).resolves.toMatchObject({
    connector: { id: connectorId }, policy: { allowed_tools: ['GMAIL_FETCH_EMAILS'] }, provider: { id: siteId },
  });
  expect(rpc).toHaveBeenCalledWith('connector_site_access', { p_site_id: siteId, p_user_id: userId });
});

it('a shared platform key never supplies another site account or grants', async () => {
  const previous = process.env.COMPOSIO_API_KEY;
  const key = randomBytes(32).toString('hex'); process.env.COMPOSIO_API_KEY = key;
  tableData.site_secrets = null;
  (tableData.site_connector_providers as any).credential_revision = `platform:${createHash('sha256').update(key).digest('hex')}`;
  try {
    await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).resolves.toMatchObject({ connector: { site_id: siteId } });
    tableData.connector_members = null;
    await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  } finally { if (previous === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = previous; }
});

it('uses the same site/user-scoped SQL visibility for list and exact lookup', async () => {
  connector.access_mode = 'workspace';
  expect(await listVisibleConnectors(siteId, userId)).toEqual([connector]);
  expect(rpc).toHaveBeenCalledWith('connector_list_visible', { p_site_id: siteId, p_user_id: userId }, { count: 'exact' });
  expect(await getVisibleConnector(siteId, userId, connectorId)).toEqual(connector);
  expect(rpc).toHaveBeenCalledWith('connector_list_visible', { p_site_id: siteId, p_user_id: userId, p_connector_id: connectorId });
  expect(from).not.toHaveBeenCalled();
});

it('rejects capped or incomplete visibility and cannot select a connector from another site', async () => {
  rpc.mockImplementationOnce(() => query([{ can_view: true }])).mockImplementationOnce(() => query([], null, 1001));
  await expect(listVisibleConnectors(siteId, userId)).rejects.toMatchObject({ code: 'CATALOG_LIMIT' });
  rpc.mockImplementationOnce(() => query([{ can_view: true }])).mockImplementationOnce(() => query([], null, 1));
  await expect(listVisibleConnectors(siteId, userId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  rpc.mockImplementationOnce(() => query([{ can_view: true }])).mockImplementationOnce(() => query({ ...connector, site_id: agentId }));
  await expect(getVisibleConnector(siteId, userId, connectorId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  await expect(getVisibleConnector(siteId, userId, agentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('inherits missing member and agent rows for active eligible identities', async () => {
  connector.access_mode = 'workspace';
  tableData.connector_members = null;
  tableData.connector_agents = null;
  expect(await listUsableConnectors(context)).toHaveLength(1);
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).resolves.toMatchObject({ connector });

  const agent = query(null);
  from.mockImplementationOnce(() => query(null)).mockImplementationOnce(() => query(null)).mockReturnValueOnce(agent);
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(agent.eq.mock.calls).toEqual([['id', agentId], ['site_id', siteId], ['status', 'active']]);

  rpc.mockReturnValueOnce(query([{ can_view: false, can_manage: false }]));
  await expect(listUsableConnectors(context)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it.each([
  ['connector_members', { can_view: false, can_use: false }],
  ['connector_members', { can_view: true, can_use: false }],
  ['connector_members', { can_view: true, can_use: true, expires_at: '2000-01-01T00:00:00Z' }],
  ['connector_members', { can_view: true, can_use: true, revoked_at: '2000-01-01T00:00:00Z' }],
  ['connector_agents', { enabled: false }],
  ['connector_agents', { enabled: true, expires_at: '2000-01-01T00:00:00Z' }],
  ['connector_agents', { enabled: true, revoked_at: '2000-01-01T00:00:00Z' }],
] as const)('never inherits past an existing %s exception (%j)', async (table, override) => {
  connector.access_mode = 'workspace';
  tableData.connector_members = null;
  tableData.connector_agents = null;
  tableData[table] = override;
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(await listUsableConnectors(context)).toEqual([]);
});

it('rejects storage errors instead of treating them as inherited authority', async () => {
  connector.access_mode = 'workspace';
  from.mockReturnValueOnce(query(null, { code: 'offline' }));
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});


it.each(['connector_members', 'connector_agents'])('rechecks a new %s exception before dispatch', async table => {
  connector.access_mode = 'workspace';
  connector.granted_scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  tableData.connector_members = null;
  tableData.connector_agents = null;
  const descriptor = {
    slug: 'GMAIL_FETCH_EMAILS', toolkitSlug: 'gmail', toolkitVersion: '20261119_01',
    schemaHash: randomBytes(32).toString('hex'), description: 'Read email.', scopes: [], scopeRequirements: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
  jest.mocked(describeConnectorTool).mockResolvedValue(descriptor);
  const dispatch = jest.fn();
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    tableData[table] = table === 'connector_members' ? { can_view: true, can_use: false } : { enabled: false };
    await input.beforeDispatch();
    return dispatch();
  });
  const runtime = createConnectorRuntime(async () => context);
  const name = `connector:${connectorId}:${descriptor.slug}`;
  expect((await runtime.search()).tools).toEqual([expect.objectContaining({ name })]);
  await expect(runtime.describe(name)).resolves.toMatchObject({ connector_id: connectorId });
  await expect(runtime.call(name, { version: descriptor.toolkitVersion, schema_hash: descriptor.schemaHash, arguments: {} }))
    .rejects.toMatchObject({ code: 'ACCESS_DENIED', executed: false, effectStarted: false });
  expect(executeConnectorTool).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
});

it.each([undefined, null, 'invalid', 'selected'])('does not widen an empty selection for mode %p', async mode => {
  tableData.connector_policies = { tool_access_mode: mode, allowed_tools: [], allowed_hosts: ['assistant'], require_approval: false };
  expect(await listUsableConnectors(context)).toEqual([]);
  await expect(authorizeConnectorExecution(context, connectorId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});

it('all discovers and executes only the compatible reviewed action, never a wildcard', async () => {
  const slug = 'GMAIL_FETCH_EMAILS';
  connector.granted_scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const policy = { tool_access_mode: 'all', allowed_tools: ['GMAIL_SEND_EMAIL'], allowed_hosts: ['assistant'], require_approval: false };
  tableData.connector_policies = policy;
  const runtime = createConnectorRuntime(async () => context);
  const name = `connector:${connectorId}:${slug}`;
  const descriptor = { slug, toolkitSlug: 'gmail', toolkitVersion: '20261119_01', schemaHash: randomBytes(32).toString('hex'),
    description: 'Read email.', scopes: [], scopeRequirements: null, inputSchema: { type: 'object', properties: {} } };
  jest.mocked(describeConnectorTool).mockResolvedValue(descriptor);
  const envelope = { version: descriptor.toolkitVersion, schema_hash: descriptor.schemaHash, arguments: {} };
  const dispatch = jest.fn().mockReturnValue({ successful: true, data: {}, logId: null });
  jest.mocked(executeConnectorTool).mockImplementation(async input => { await input.beforeDispatch(); return dispatch(); });
  expect((await runtime.search()).tools.map(tool => tool.name)).toEqual([name]);
  await expect(runtime.describe(name)).resolves.toMatchObject({ connector_id: connectorId });
  await expect(runtime.call(name, envelope)).resolves.toMatchObject({ success: true });
  expect(executeConnectorTool).toHaveBeenCalledWith(expect.objectContaining({ allowedTools: [slug], toolSlug: slug }));
  for (const denied of ['GMAIL_SEND_EMAIL', 'HUBSPOT_LIST_CONTACTS']) {
    const ref = `connector:${connectorId}:${denied}`;
    await expect(runtime.describe(ref)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(runtime.call(ref, envelope)).rejects.toMatchObject({ code: 'ACCESS_DENIED', executed: false });
  }
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    policy.tool_access_mode = 'selected';
    await input.beforeDispatch();
    return dispatch();
  });
  await expect(runtime.call(name, envelope)).rejects.toMatchObject({ code: 'ACCESS_DENIED', executed: false });
  expect(dispatch).toHaveBeenCalledTimes(1);
  policy.tool_access_mode = 'all';
  connector.toolkit_slug = 'supabase';
  expect((await runtime.search()).tools).toEqual([]);
});


it('uses exact visible account discovery only and rejects alternate account references even when the model supplies them', async () => {
  const bound = { ...context, connectorIdHint: connectorId };
  expect(await listUsableConnectors(bound)).toHaveLength(1);
  expect(rpc.mock.calls.filter(([name]) => name === 'connector_list_visible')).toEqual([['connector_list_visible', {
    p_site_id: siteId, p_user_id: userId, p_connector_id: connectorId,
  }]]);
  await expect(authorizeConnectorExecution(bound, agentId, 'GMAIL_FETCH_EMAILS')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(listUsableConnectors({ ...context, connectorIdHint: agentId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  tableData.connector_agents = null;
  expect(await listUsableConnectors(bound)).toEqual([]);
  expect(describeConnectorTool).not.toHaveBeenCalled(); expect(executeConnectorTool).not.toHaveBeenCalled();
});

it.each(['view-only', 'absent agent', 'both'])('opt-in permits a private concrete request, not execution (%s)', async missing => {
  const policy = tableData.connector_policies as { require_approval: boolean };
  connector.granted_scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  if (missing !== 'absent agent') tableData.connector_members = { can_use: false, can_view: true };
  if (missing !== 'view-only') tableData.connector_agents = null;
  const bound = { ...context, instanceId: siteId, requestId: connectorId };
  const runtime = createConnectorRuntime(async () => bound);
  expect((await runtime.search()).tools).toEqual([]);
  policy.require_approval = true;
  const slug = 'GMAIL_FETCH_EMAILS', name = `connector:${connectorId}:${slug}`;
  const d = { slug, toolkitSlug:'gmail', toolkitVersion:'1.0', schemaHash: randomBytes(32).toString('hex'),
    scopes:[], scopeRequirements:null, description:'', inputSchema:{type:'object', properties:{}} };
  jest.mocked(describeConnectorTool).mockResolvedValue(d);
  expect((await runtime.search()).tools).toEqual([expect.objectContaining({name, request_only:true})]);
  expect(await runtime.describe(name)).toMatchObject({require_approval:true});
  await expect(authorizeConnectorExecution(bound, connectorId, slug)).rejects.toMatchObject({code:'ACCESS_DENIED'});
  const propose = jest.spyOn(await import('../approval-proposals'), 'proposeInteractiveConnectorAction').mockResolvedValue({status:'pending'});
  try {
    expect(await runtime.call(name, {version:d.toolkitVersion,schema_hash:d.schemaHash,arguments:{}})).toEqual({success:true,status:'pending'});
    expect(propose).toHaveBeenCalledWith(bound, expect.objectContaining({requestOnly:true}), d, {});
    expect(executeConnectorTool).not.toHaveBeenCalled();
  } finally { propose.mockRestore(); }
});

it.each([
  ['connector_members', { can_view:false,can_use:false }], ['connector_members', { can_view:true,can_use:false,revoked_at:'2025-01-01' }],
  ['connector_members', { can_view:true,can_use:false,expires_at:'2025-01-01' }], ['connector_agents', { enabled:false }],
  ['connector_agents', { enabled:true,revoked_at:'2025-01-01' }], ['connector_agents', { enabled:true,expires_at:'2025-01-01' }],
  ['agents', null],
] as const)('request opt-in never overrides %s veto %j', async (table, row) => {
  (tableData.connector_policies as {require_approval:boolean}).require_approval = true;
  tableData[table] = row;
  expect(await listUsableConnectors(context,true)).toEqual([]);
});

it('never falls back from a missing SQL-visible account to request discovery', async () => {
  (tableData.connector_policies as {require_approval:boolean}).require_approval = true;
  rpc.mockImplementation(name => name === 'connector_list_visible' ? query([]) : query([{can_view:true}]));
  expect(await listUsableConnectors(context,true)).toEqual([]);
  expect(from).not.toHaveBeenCalled();
});


it('manager execution requires current own use and original host policy, not a grant delegated to an agent', async () => {
  const slug = 'GMAIL_FETCH_EMAILS';
  tableData.connector_agents = {enabled:false};
  expect(await resolveManagerAction(siteId,userId,connectorId,slug)).toMatchObject({connector:{id:connectorId}});
  expect(from).not.toHaveBeenCalledWith('connector_agents');
  (tableData.connector_policies as {allowed_hosts:string[]}).allowed_hosts = ['direct'];
  await expect(resolveManagerAction(siteId,userId,connectorId,slug)).rejects.toMatchObject({code:'ACCESS_DENIED'});
  (tableData.connector_policies as {allowed_hosts:string[]}).allowed_hosts = ['assistant'];
  tableData.connector_members = {can_view:true,can_use:false};
  await expect(resolveManagerAction(siteId,userId,connectorId,slug)).rejects.toMatchObject({code:'ACCESS_DENIED'});
});
