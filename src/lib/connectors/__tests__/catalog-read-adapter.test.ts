import { attestedProject } from './byok-rpc-fixture';
import companies from './fixtures/HUBSPOT_LIST_COMPANIES-20261116_01.json';
import deals from './fixtures/HUBSPOT_LIST_DEALS-20261116_01.json';
import calendars from './fixtures/GOOGLECALENDAR_LIST_CALENDARS-20261116_00.json';
import { randomUUID } from 'node:crypto';
import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { ConnectorError } from '../types';
import { accountFixture, connectorFixture, providerFixture, toolkitFixture, toolFixture, secret, jsonResponse } from './composio-fixtures';

const mockProofRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args:unknown[]) => mockProofRpc(...args) } }));
jest.mock('../access', () => ({}));
const original = { fetch: global.fetch, origin: process.env.CONNECTORS_WEB_ORIGIN };
const http = jest.fn();
beforeEach(() => { http.mockReset(); global.fetch = http; process.env.CONNECTORS_WEB_ORIGIN = 'https://app.example.test'; });
afterEach(() => {
  global.fetch = original.fetch;
  if (original.origin === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = original.origin;
});
function fixture(toolkit = 'planning', resource = 'deliverables') {
  const site_id = randomUUID(); const revision = secret();
  const provider = { ...providerFixture(), site_id, provider_user_id: site_id, credential_revision: revision };
  mockProofRpc.mockImplementation(attestedProject({ ...provider }));
  const scope = resource + ':read'; const slug = `${toolkit.toUpperCase()}_LIST_${resource.toUpperCase()}`;
  const tool = { ...toolFixture(), slug, toolkit: { slug: toolkit }, tags: ['readOnlyHint'], description: `Lists ${resource}.`, scopes: [scope],
    input_parameters: { type: 'object', properties: { limit: { type: 'integer', maximum: 100, default: 100 }, page: { type: 'integer' } } },
    output_parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'integer' }, name: { type: 'string' }, title: { type: 'string' } } } } } } };
  const api = { ...toolkitFixture(), slug: toolkit, enabled: true };
  const account = { ...accountFixture(), toolkit: { slug: toolkit }, user_id: site_id, state: { authScheme: 'OAUTH2', val: { scope: `${scope} tasks.read` } } };
  const input = { credential: { apiKey: secret(), revision }, connector: { ...connectorFixture(), site_id, toolkit_slug: toolkit, granted_scopes: [] },
    provider, toolSlug: slug, catalogRead: true };
  const queue = (...rows: unknown[]) => rows.forEach(row => http.mockResolvedValueOnce(jsonResponse(row)));
  return { tool, input, api, account, scope, queue };
}
async function pinned(f = fixture()) {
  f.queue(f.tool, f.api, f.account);
  const description = await describeConnectorTool(f.input); http.mockReset();
  return { ...f, description, call: { ...f.input, input: { limit: 3 }, schemaHash: description.schemaHash, toolkitVersion: description.toolkitVersion,
    allowedTools: [f.tool.slug], requiredScopes: [], beforeDispatch: jest.fn(async () => undefined) } };
}
const noPost = () => expect(http.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);

it.each(['LIST_ALL','GET','FETCH_ALL'])('recognizes a %s collection only under the same bounded native read contract',async verb=>{
  const f=fixture('warehouse','pallets'); f.tool.slug=`WAREHOUSE_${verb}_PALLETS`; f.input.toolSlug=f.tool.slug;
  Object.assign(f.tool.input_parameters.properties,{offset:{type:'integer'}});
  const {call,queue,tool,api,account}=await pinned(f);
  queue(tool,api,account,{successful:true,error:null,data:{items:[{id:1}]}});
  await expect(executeConnectorTool(call)).resolves.toMatchObject({successful:true,data:{items:[{id:1}]}});
  http.mockReset(); queue(tool,api,account);
  await expect(executeConnectorTool({...call,input:{limit:3,offset:40000}})).rejects.toMatchObject({executed:false}); noPost();
});

it.each(['GET_ALL_CREDENTIALS','FETCH_USER','GET_ALL','REPLACE_PALLETS','FETCH_PALLETS_AND_EXPORT'])('does not infer read authority from %s',async suffix=>{
  const f=fixture('warehouse','pallets'); f.tool.slug=`WAREHOUSE_${suffix}`; f.input.toolSlug=f.tool.slug; f.queue(f.tool);
  await expect(describeConnectorTool(f.input)).rejects.toMatchObject({code:'TOOL_UNREVIEWED'}); noPost();
});

it.each([['planning', 'deliverables'], ['warehouse', 'pallets']])('projects and executes a new native %s list contract without registering a slug or resource', async (kit, resource) => {
  const { tool, call, queue, account, api, description } = await pinned(fixture(kit, resource));
  expect(description.catalogModelSchema).toEqual({ type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 25 },
    page: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['limit'], additionalProperties: false });
  const token = secret(); const diagnostic = secret(); const key = call.credential.apiKey;
  queue(tool, api, account, { successful: true, error: null, log_id: diagnostic, logs: [{ details: diagnostic }], data: {
    items: [{ id: 1, name: 'Grocery Order', title: `Bearer ${token}`, access_token: token }, { id: 2, name: key, title: token }], details: diagnostic } });
  call.beforeDispatch.mockImplementation(async () => { expect(http).toHaveBeenCalledTimes(3); call.input.limit = 10000; call.provider.provider_user_id = randomUUID(); });
  const result = await executeConnectorTool(call);
  expect(result).toEqual({ successful: true, data: { items: [{ id: 1, name: 'Grocery Order' }, { id: 2 }] } });
  for (const value of [key, token, diagnostic]) expect(JSON.stringify(result)).not.toContain(value);
  expect(http.mock.calls[0][0]).toMatch(new RegExp(`/tools/${tool.slug}\\?version=${tool.version}$`));
  expect(JSON.parse(http.mock.calls[3][1].body)).toEqual({ connected_account_id: account.id, user_id: account.user_id, version: tool.version, arguments: { limit: 3 } });
  expect(call.beforeDispatch).toHaveBeenCalledTimes(1);
});

it('does not use catalog proofs by default, or bypass a reviewed action when opted in', async () => {
  const { input } = fixture();
  for (const flag of [undefined, false]) await expect(describeConnectorTool({ ...input, catalogRead: flag })).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED' });
  await expect(describeConnectorTool({ ...input, toolSlug: 'SUPABASE_LIST_TABLES' })).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED' });
  expect(http).not.toHaveBeenCalled();
});

it.each([
  { tags: [] }, { tags: ['readOnlyHint', 'destructiveHint'] }, { tags: ['readOnlyHint', 'other'] }, { no_auth: true }, { deprecated: { is_deprecated: true } },
  { version: 'latest' }, { version: 'canary' }, { scopes: [] }, { scopes: ['*'] }, { scopes: ['read'] }, { scopes: ['secrets:read'] },
  { scopes: ['deliverables:read', 'deliverables:write'] }, { scope_requirements: { any_of: [] } }, { description: 'Lists and updates deliverables.' },
  { output_parameters: {} }, { output_parameters: undefined },
  { input_parameters: {type:'object', properties:{limit:{type:'integer',description:'Exports records to a file.'}}} },
  { output_parameters: {type:'object', properties:{items:{type:'array',items:{type:'object',properties:{name:{type:'string',description:'API credentials'}}}}}} },
])('denies ambiguous descriptors before dispatch: %j', async changed => {
  const { input, tool, queue } = fixture(); queue({ ...tool, ...changed });
  await expect(describeConnectorTool(input)).rejects.toBeInstanceOf(ConnectorError); noPost(); expect(http).toHaveBeenCalledTimes(1);
});

it.each(['secrets','identities','credentials','api_keys','exports','members','shell_scripts','files','signed_urls','webhooks','tokens','accounts','queries','tables'])('denies sensitive or indirect resource %s despite a matching scope and tag', async resource => {
  const { input, tool, queue } = fixture('planning', resource); queue(tool); await expect(describeConnectorTool(input)).rejects.toMatchObject({code:'TOOL_UNREVIEWED'}); noPost();
});

it.each([
  { provider: 'custom', scheme: 'OAUTH2', expected: 'PROVIDER_INVALID_RESPONSE' },
  { variant: 'mcp', expected: 'TOOL_UNREVIEWED' }, { state: null, expected: 'CONNECTOR_SCOPE_UNSUPPORTED' },
  { grants: [], expected: 'CONNECTOR_SCOPE_MISSING' }, { grants: 'tasks.read', expected: 'CONNECTOR_SCOPE_MISSING' },
  { grants: 'deliverables:read tasks.write', expected: 'CONNECTOR_SCOPE_UNSUPPORTED' }, { grants: 'deliverables:read users.read', expected: 'CONNECTOR_SCOPE_UNSUPPORTED' },
  { grants: 'deliverables:read offline_access', expected:'CONNECTOR_SCOPE_UNSUPPORTED' }, { scheme: 'API_KEY', expected: 'CONNECTOR_SCOPE_UNSUPPORTED' },
  { private: false, expected: 'CONNECTOR_ACCOUNT_MISMATCH' }, { owner: 'some_other_site', expected:'CONNECTOR_ACCOUNT_MISMATCH' },
])('checks live grants, account type, toolkit and owner: %j', async row => {
  const { tool, call, queue, api, account } = await pinned();
  const modified = { ...account, user_id: row.owner ?? account.user_id, experimental: row.private === false ? undefined : account.experimental,
    state: { authScheme: row.scheme ?? 'OAUTH2', val: row.state === null ? {} : { scope: row.grants ?? account.state.val.scope } } };
  queue(tool, { ...api, type: row.provider ?? api.type, toolkit_type: row.variant ?? 'api' }, modified);
  await expect(executeConnectorTool(call)).rejects.toMatchObject({ code: row.expected, executed: false, effectStarted: false });
  noPost(); expect(call.beforeDispatch).not.toHaveBeenCalled();
});

it.each([{ limit: 26 }, { limit: 1.5 }, { limit: '1' }, { page: 2 }, { limit: 1, page: 101 }, { limit: 1, query: 'tasks' },
  { limit: 2, account_id: 'wrong' }, { limit: 2, url: 'https://service.example.test' }])('revalidates the projected schema at execution even without a host validator (%j)', async args => {
  const { call, queue, tool, api, account } = await pinned(); queue(tool, api, account);
  await expect(executeConnectorTool({ ...call, input: args })).rejects.toMatchObject({ executed: false, effectStarted: false });
  noPost(); expect(call.beforeDispatch).not.toHaveBeenCalled();
});

it.each(['hash', 'version', 'description', 'schema', 'callback', 'allowlist', 'credential', 'project', 'attestation', 'owner', 'account-id', 'action', 'toolkit'])(
  'blocks %s drift or missing authority; never posts', async kind => {
    const { call, tool, queue, api, account } = await pinned();
    if (kind === 'hash') call.schemaHash = '0'.repeat(64);
    if (kind === 'description') tool.description += ' A different contract.';
    if (kind === 'version') tool.version = '20261201_00';
    if (kind === 'schema') tool.input_parameters.properties.limit.maximum = 90;
    if (kind === 'action') tool.slug += '_CHANGED';
    if (kind === 'toolkit') tool.toolkit.slug = 'another';
    if (kind === 'callback') call.beforeDispatch.mockRejectedValue(new ConnectorError('ACCESS_CHANGED', 'Access changed.', 403));
    if (kind === 'allowlist') call.allowedTools = [];
    if (kind === 'account-id') account.id = 'another';
    if (kind === 'credential') call.provider.credential_revision = secret();
    if (kind === 'project') call.connector.provider_project_id = 'other';
    if (kind === 'owner') call.provider.provider_user_id = randomUUID();
    if (kind === 'attestation') {
      mockProofRpc.mockImplementation(attestedProject({ ...call.provider, project_id: 'other' }));
    }
    queue(tool, api, account);
    await expect(executeConnectorTool(call)).rejects.toMatchObject({ executed: false, effectStarted: false }); noPost();
    if (kind !== 'callback') expect(call.beforeDispatch).not.toHaveBeenCalled();
  });

it.each([
  ['unknown selector', { limit:{type:'integer'}, website:{type:'string'} }], ['no size control', { page:{type:'integer'} }],
  ['provider-controlled input bag', { limit:{type:'object'} }], ['unvalidated integer constraint', { limit:{type:'integer',multipleOf:10} }],
  ['tunneled union', { limit: { anyOf:[{type:'integer'},{type:'string'}] } }], ['impossible bound', {limit:{type:'integer',minimum:100}}],
])('blocks %s inside a seemingly read-only provider input schema', async (_label, properties) => {
  const { input, queue, tool } = fixture(); queue({ ...tool, input_parameters: { type: 'object', properties } });
  await expect(describeConnectorTool(input)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' }); noPost();
});

it.each([
  { details: 'unknown collection' }, { items: [{ access_token: secret() }] }, { items:[{id: {nested:'invalid'}}] }, { items:[{id:1},{id:2},{id:3},{id:4}] },
])('reports already-dispatched unsupported payloads safely (%#)', async data => {
  const { call, tool, queue, api, account } = await pinned(); const sensitive = secret();
  queue(tool, api, account, { successful:true, error:null, data, diagnostic:sensitive });
  const err = await executeConnectorTool(call).catch(value => value);
  expect(err).toMatchObject({ code:'CONNECTOR_RESULT_UNSUPPORTED' }); expect(err.effectStarted).not.toBe(false);
  expect(JSON.stringify(err)).not.toContain(sensitive); expect(http).toHaveBeenCalledTimes(4);
});

it('uses explicit structural application status only; no provider error, data, log or token crosses the boundary', async () => {
  const { call, tool, queue, api, account } = await pinned(); const sensitive = secret();
  queue(tool, api, account, { successful:false, error:sensitive, data:{ status_code:403, detail:sensitive }, logs:[sensitive] });
  const err = await executeConnectorTool(call).catch(value => value);
  expect(err).toMatchObject({ code:'APP_RESOURCE_DENIED' }); expect(err.effectStarted).not.toBe(false);
  expect(String(err)).not.toContain(sensitive); expect(http).toHaveBeenCalledTimes(4);
});


it('uses only a narrow provider-enforced OAuth portal read if scopes were omitted; an explicit empty/insufficient grant is never ignored', async () => {
  const f = published('companies');
  const unknown = { ...f.account, state: { authScheme: 'OAUTH2', val: {} } };
  f.queue(f.tool, f.api, unknown);
  const descriptor = await describeConnectorTool(f.input);
  const call = { ...f.input, input:{limit:1}, schemaHash:descriptor.schemaHash, toolkitVersion:f.tool.version,
    allowedTools:[f.tool.slug], requiredScopes:[], beforeDispatch:jest.fn(async () => undefined) };
  for (const scope of [[], ['something:read'], ['crm.objects.companies.read','companies.write']]) {
    http.mockReset(); f.queue(f.tool, f.api, { ...unknown, state: { authScheme:'OAUTH2', val:{scope} } });
    await expect(executeConnectorTool(call)).rejects.toMatchObject({ executed:false, effectStarted:false }); noPost();
  }
  http.mockReset(); f.queue(f.tool, f.api, unknown, { successful:true,error:null,data:{results:[crmRow('name','Commercial')]} });
  await expect(executeConnectorTool(call)).resolves.toEqual({ successful:true,data:{items:[{id:'12',name:'Commercial'}]} });
});

it('does not replace explicit grant evidence from the exact account with a reduced owner-proof list DTO', async () => {
  const f = published('companies');
  const raw = { ...f.account, user_id:undefined, state:{ authScheme:'OAUTH2', val:{scope:[]} } };
  f.queue(f.tool, f.api, raw, { items:[{ ...raw, state:{authScheme:'OAUTH2', val:{}} }],next_cursor:null });
  await expect(describeConnectorTool(f.input)).rejects.toMatchObject({code:'CONNECTOR_SCOPE_MISSING'}); noPost();
});

// Exact JSON from https://docs.composio.dev/api/tools/{slug}?version={version} (public docs viewer).
// The toolkit pages independently publish tags, scopes and releases; only account/row data are synthetic.
const gcal = 'https://www.googleapis.com/auth/calendar';
function published(resource: 'companies' | 'deals' | 'calendars') {
  const calendar = resource === 'calendars';
  const f = fixture(calendar ? 'googlecalendar' : 'hubspot', resource);
  const version = calendar ? '20261116_00' : '20261116_01';
  const schemas = structuredClone(resource === 'companies' ? companies : calendar ? calendars : deals);
  const tags = calendar ? ['readOnlyHint', 'idempotentHint', 'openWorldHint'] : ['Basic', 'openWorldHint', 'readOnlyHint'];
  const scopes = calendar ? [gcal, `${gcal}.readonly`, `${gcal}.calendarlist`, `${gcal}.calendarlist.readonly`] : [`crm.objects.${resource}.read`];
  const description = calendar
    ? "Lists calendars accessible through the connected user's CalendarList, returning IDs and user-specific metadata such as access role, color, visibility, selection, and reminders. Hidden calendars are omitted unless show_hidden is true; min_access_role and show_deleted provide additional filtering. Continue with page_token until next_page_token is absent; for incremental synchronization, pass next_sync_token back as sync_token. Use returned IDs, not display names, with event actions, and use GOOGLECALENDAR_GET_CALENDAR for canonical metadata about one known calendar."
    : `Retrieves a paginated list of HubSpot ${resource}.`;
  Object.assign(f.tool, { ...schemas, version, tags, scopes, description });
  f.account.state.val.scope = calendar ? `${gcal}.calendarlist.readonly` : `oauth crm.objects.${resource}.read`;
  return f;
}
const crmRow = (key: string, name: string) => ({ id: '12', createdAt: '2026-01-01', updatedAt: '2026-02-01', archived: false, properties: { [key]: name } });

it.each(['companies', 'deals'] as const)('executes the public %s schema with local-only selectors and a single bounded projection', async resource => {
  const f = published(resource);
  f.queue(f.tool, f.api, f.account);
  const desc = await describeConnectorTool(f.input);
  expect(http.mock.calls[0][0]).toMatch(/\?version=20261116_01$/);
  expect(desc.catalogModelSchema).toEqual({ type: 'object', required: ['limit'], additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } } });
  const name = resource === 'companies' ? 'name' : 'dealname'; const sensitive = secret();
  const row = crmRow(name, 'Quarterly renewal');
  const call = { ...f.input, input: { limit: 2 }, schemaHash: desc.schemaHash, toolkitVersion: desc.toolkitVersion,
    allowedTools: [f.tool.slug], requiredScopes: [], beforeDispatch: jest.fn(async () => undefined) };
  http.mockReset(); f.queue(f.tool, f.api, f.account, { successful: true, error: null, data: {
    paging: { next: { after: sensitive, link: sensitive } }, results: [{ ...row, properties: { ...row.properties, email: sensitive }, associations: { contacts: sensitive } },
      { ...row, id: '13', properties: { [name]: f.input.credential.apiKey } }] }, logs: [{ message: sensitive }] });
  await expect(executeConnectorTool(call)).resolves.toEqual({ successful: true, data: { items: [{ id: '12', name: 'Quarterly renewal' }, { id: '13' }] } });
  expect(JSON.parse(http.mock.calls[3][1].body)).toEqual({ connected_account_id: f.account.id, user_id: f.account.user_id, version: '20261116_01',
    arguments: { limit: 2, archived: false, properties: [name] } });
  for (const field of ['properties', 'archived', 'after', 'associations', 'propertiesWithHistory', 'portal_id']) {
    http.mockReset(); f.queue(f.tool, f.api, f.account);
    await expect(executeConnectorTool({ ...call, input: { limit: 1, [field]: sensitive } })).rejects.toMatchObject({ effectStarted: false }); noPost();
  }
});

it('projects a CalendarList from the published data.calendars field without reflecting calendar identifiers, summary, owner, URL or sync token', async () => {
  const f = published('calendars'); const { description, call } = await pinned(f);
  expect(Object.keys(description.catalogModelSchema?.properties as object)).toEqual(['max_results']);
  const sensitive = secret(); const id = `${sensitive}@example.invalid`;
  const entry = { kind:'calendar#calendarListEntry', etag: sensitive, id, summary:'Business Name', dataOwner:id, display_url:sensitive, location:sensitive };
  f.queue(f.tool,f.api,f.account,{ successful:true,error:null,data:{ calendars: [{...entry, primary:true, accessRole:'owner'}, entry], next_sync_token:sensitive } });
  const result = await executeConnectorTool({ ...call,input:{max_results:2} });
  expect(result).toEqual({successful:true,data:{items:[{name:'Primary calendar (owner)'},{name:'Calendar'}]}});
  expect(JSON.parse(http.mock.calls[3][1].body)).toEqual({connected_account_id:f.account.id,user_id:f.account.user_id,version:'20261116_00',arguments:{max_results:2,show_deleted:false,show_hidden:false}});
  for(const args of [{ page_token:sensitive },{sync_token:sensitive},{calendar_id:id},{show_hidden:true},{min_access_role:'owner'},{max_results:26}]) {
    http.mockReset(); f.queue(f.tool,f.api,f.account);
    await expect(executeConnectorTool({...call,input:{max_results:2,...args}})).rejects.toMatchObject({ effectStarted:false });noPost();
  }
  for(const [scope,code] of [[undefined,'CONNECTOR_SCOPE_UNSUPPORTED'], [[], 'CONNECTOR_SCOPE_MISSING'], [[gcal],'CONNECTOR_SCOPE_UNSUPPORTED'],
    [[`${gcal}.readonly`,gcal], 'CONNECTOR_SCOPE_UNSUPPORTED'], [[`${gcal}.events.readonly`], 'CONNECTOR_SCOPE_UNSUPPORTED']] as const) {
    http.mockReset();f.queue(f.tool,f.api,{...f.account,state:{authScheme:'OAUTH2',val:{scope}}});
    await expect(executeConnectorTool({...call,input:{max_results:1}})).rejects.toMatchObject({code,effectStarted:false});noPost();
  }
});

it('rejects drift in published shape, scope, defaults, local references, tag or version before looking up the account', async () => {
  const f = published('companies'); const provider = companies.input_parameters; const output = companies.output_parameters;
  for (const change of [{description:'Lists companies and updates their archive status.'},{tags:['readOnlyHint']}, {tags:[...f.tool.tags, 'updateHint']}, {version:'20261201_01'}, {scopes:[...f.tool.scopes,'crm.objects.contacts.read']},
    {input_parameters:{...provider,properties:{...provider.properties,portal_id:{type:'string'}}}},
    {input_parameters:{...provider,properties:{...provider.properties,after:{...provider.properties.after,default:'123'}}}},
    {output_parameters:{...output,properties:{...output.properties,data:{$ref:'https://example.invalid/schema'}}}},
    {output_parameters:{...output,$defs:{...output.$defs,Company:{type:'object'}}}}]) {
    http.mockReset();f.queue({...f.tool,...change});
    await expect(describeConnectorTool(f.input)).rejects.toBeInstanceOf(ConnectorError);expect(http).toHaveBeenCalledTimes(1);noPost();
  }
});

it.each(['companies','calendars'] as const)('rejects foreign wrappers, malformed/archived rows and oversized %s pages after dispatch', async resource => {
  const f=published(resource);const {call}=await pinned(f); const isCrm=resource==='companies';
  const row=isCrm?crmRow('name','Company'):{id:'example',etag:'test',kind:'calendar#calendarListEntry'};
  const collection=isCrm?'results':'calendars';const input=isCrm?{limit:1}:{max_results:1};
  for(const data of [{items:[row]}, {[collection]:[row,row]}, {response_data:{[collection]:[row]}},
    {[collection]:[{...row,archived:true,deleted:true}]}, {[collection]:[{id:'12'}]}]) {
    http.mockReset();f.queue(f.tool,f.api,f.account,{successful:true,error:null,data});
    await expect(executeConnectorTool({...call,input})).rejects.toMatchObject({code:'CONNECTOR_RESULT_UNSUPPORTED'});
    expect(http).toHaveBeenCalledTimes(4);
  }
});

it('starts the Supabase report lookup at its published release, never a provider floating release', async () => {
  const f=fixture('supabase','reports'); const slug='SUPABASE_RUN_READ_ONLY_QUERY'; f.queue({...f.tool,slug,version:'20261201_00'});
  await expect(describeConnectorTool({...f.input,toolSlug:slug})).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED'});
  expect(http.mock.calls[0][0]).toMatch(/\/SUPABASE_RUN_READ_ONLY_QUERY\?version=20261116_00$/); noPost();
});
