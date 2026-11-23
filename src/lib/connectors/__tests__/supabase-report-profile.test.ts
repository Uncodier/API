import { attestedProject } from './byok-rpc-fixture';
import publishedContract from './fixtures/supabase-report-20261116_00.json';
import { randomUUID } from 'node:crypto';
import { describeConnectorTool, executeConnectorTool, hashConnectorSchema } from '../composio-sessions';
import { loadExternalDataset } from '../supabase-analytics-registry';
import { assertReportContract, reportBinding, reportModelSchema, reportRequest } from '../supabase-report-contract';
import { projectSupabaseCatalogResult, SUPABASE_CATALOG_SLUG } from '../supabase-report-profile';
import { conversationReviewSlugs, getReviewedTool } from '../reviewed-tools';
import { accountFixture, connectorFixture, providerFixture, toolkitFixture, toolFixture, secret, jsonResponse } from './composio-fixtures';

// A bound external project without a mapped analytics dataset retains the published-view profile.
const mockProofRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args:unknown[]) => mockProofRpc(...args) } }));
jest.mock('../supabase-analytics-registry', () => ({loadExternalDataset: jest.fn(async () => null)}));
jest.mock('../access', () => ({}));
const http = jest.fn();
const original = { fetch: global.fetch, origin: process.env.CONNECTORS_WEB_ORIGIN };
beforeEach(() => { http.mockReset(); global.fetch = http; process.env.CONNECTORS_WEB_ORIGIN = 'https://app.example.test'; });
afterEach(() => {
  global.fetch = original.fetch;
  if (original.origin === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = original.origin;
});
function fixture() {
  const site_id = randomUUID(); const revision = secret(); const ref = 'a'.repeat(20);
  const provider = { ...providerFixture(), site_id, provider_user_id: site_id, credential_revision: revision };
  mockProofRpc.mockImplementation(attestedProject({ ...provider }));
  const slug = SUPABASE_CATALOG_SLUG;
  const tool = { ...toolFixture(), slug, toolkit: { slug: 'supabase' }, version: '20261116_00', scopes: ['database_read'],
    tags: ['important', 'readOnlyHint', 'openWorldHint', 'Database'], input_parameters: { type: 'object', required: ['query', 'ref'], properties: {
      query: { type: 'string' }, ref: { type: 'string', pattern: '^[a-z]{20}$', minLength: 20, maxLength: 20 },
      parameters: { anyOf: [{ type: 'array', items: {} }, { type: 'null' }], default: null },
    } } };
  const toolkit = { ...toolkitFixture(), slug: 'supabase', name: 'Supabase' };
  const account = { ...accountFixture(), toolkit: tool.toolkit, user_id: site_id, state: { authScheme: 'API_KEY', val: { full: 'https://api.supabase.com' } } };
  const connector = { ...connectorFixture(), site_id, toolkit_slug: 'supabase', supabase_project_ref: ref, granted_scopes: [] };
  const input = { localProjectRef: 'b'.repeat(20), credential: { apiKey: secret(), revision }, connector, provider, toolSlug: slug, catalogRead: true };
  const frame = (view: string | null, rows: unknown) => [{ report_schema: reportBinding(connector).schema, report_view: view, report_rows: rows }];
  const queue = (...values: unknown[]) => values.forEach(v => http.mockResolvedValueOnce(jsonResponse(v)));
  return { input, tool, toolkit, account, frame, queue };
}
async function pinned() {
  const f = fixture(); f.queue(f.tool, f.toolkit, f.account);
  const descriptor = await describeConnectorTool(f.input); http.mockReset();
  return { ...f, descriptor, call: { ...f.input, input: { view: 'sales', limit: 2 }, schemaHash: descriptor.schemaHash,
    toolkitVersion: descriptor.toolkitVersion, allowedTools: [f.tool.slug], requiredScopes: ['database_read'], beforeDispatch: jest.fn() } };
}
const noPost = () => expect(http.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);

test('describes the model projection only and executes exactly one credential-bound, parameterized native operation', async () => {
  const { descriptor, call, tool, toolkit, account, queue, frame } = await pinned();
  expect(descriptor.description).not.toBe(tool.description);
  expect(descriptor.description).toContain('No direct analytics sources are registered');
  expect(descriptor.description).toContain('not to answer a data question');
  expect(Object.keys((descriptor.inputSchema as {properties: object}).properties)).toEqual(['view', 'after', 'limit']);
  expect(JSON.stringify(descriptor)).not.toContain(reportBinding(call.connector).schema);
  const opaque = secret();
  queue(tool, toolkit, account, { successful: true, error: null, data: frame('sales', [{ label: 'November', value: '124.50' }]), logs: [opaque] });
  const result = await executeConnectorTool(call);
  expect(result.data).toMatchObject({ view: 'sales', rows: [{ label: 'November', value: '124.50' }] });
  expect(JSON.stringify(result)).not.toContain(opaque); expect(JSON.stringify(result)).not.toContain(call.credential.apiKey);
  const posts = http.mock.calls.filter(c => c[1].method === 'POST'); expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe(`https://backend.composio.dev/api/v3.1/tools/execute/${tool.slug}`);
  const body = JSON.parse(posts[0][1].body); const schema = reportBinding(call.connector).schema;
  expect(body).toEqual({ connected_account_id: account.id, user_id: call.provider.site_id, version: tool.version,
    arguments: { ref: call.connector.supabase_project_ref, query: expect.stringContaining(`FROM ONLY "${schema}"."sales"`),
      parameters: [schema, 'sales', `"${schema}"."sales"`, '2'] } });
  expect(call.beforeDispatch).toHaveBeenCalledTimes(1);
});

test('a pinned description never works for a different project binding, auth type, origin, scope, or legacy dispatch', async () => {
  const { call, tool, toolkit, account, queue } = await pinned();
  for (const acc of [{ ...account, state: { authScheme: 'OAUTH2', val: {} } }, { ...account, experimental: { account_type: 'SHARED' } },
    { ...account, data: { base_url: 'https://example.invalid' } }, { ...account, state: { ...account.state, val: { full: 'http...' } } }]) {
    http.mockReset(); queue(tool, toolkit, acc);
    await expect(executeConnectorTool(call)).rejects.toMatchObject({ effectStarted: false }); noPost();
  }
  http.mockReset(); queue(tool, toolkit, account);
  await expect(executeConnectorTool({ ...call, requiredScopes: ['database_write'] })).rejects.toMatchObject({ effectStarted: false }); noPost();
  http.mockReset(); queue(tool, toolkit, account);
  await expect(executeConnectorTool({ ...call, connector: { ...call.connector, supabase_project_ref: 'b'.repeat(20) } }))
    .rejects.toMatchObject({ code: 'CONNECTOR_SCHEMA_CHANGED', effectStarted: false }); noPost();
  http.mockReset();
  await expect(executeConnectorTool({ ...call, catalogRead: false })).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED', effectStarted: false });
  expect(() => getReviewedTool(tool.slug, 'supabase')).toThrow(); expect(conversationReviewSlugs).not.toContain(tool.slug);
  expect(http).not.toHaveBeenCalled(); expect(call.beforeDispatch).not.toHaveBeenCalled();
});

test('no SQL, project, foreign relation or unbound lookup can reach dispatch, including after a successful describe', async () => {
  const { call, tool, toolkit, account, queue } = await pinned();
  for (const args of [{ query: 'example' }, { project_ref: 'b'.repeat(20) }, { view: 'other.sales' }, { limit: 26 }]) {
    http.mockReset(); queue(tool, toolkit, account);
    await expect(executeConnectorTool({ ...call, input: args })).rejects.toMatchObject({ effectStarted: false }); noPost();
  }
  for (const slug of ['SUPABASE_SELECT_FROM_TABLE', 'SUPABASE_BETA_RUN_SQL_QUERY', 'SUPABASE_GET_PROJECT']) {
    http.mockReset(); queue({ ...tool, slug });
    await expect(executeConnectorTool({ ...call, toolSlug: slug, allowedTools: [slug] })).rejects.toMatchObject({ effectStarted: false }); noPost();
  }
  expect(call.beforeDispatch).not.toHaveBeenCalled();
});

it('does not impose an OAuth scope ceiling on a verified reporting PAT; respects a real provider denial', async () => {
  const {call, tool, toolkit, account, queue} = await pinned();
  const live = {...account, state:{...account.state, val:{...account.state.val,scope:'projects:read database_read'}}};
  const connector = {...call.connector, granted_scopes:['projects:read']};
  queue(tool, toolkit, live, {successful:false,error:'Denied',data:{status_code:403}});
  await expect(executeConnectorTool({...call, connector})).rejects.toMatchObject({code:'APP_RESOURCE_DENIED'});
  const posts = http.mock.calls.filter(([,init])=>init.method==='POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0][1].body)).toMatchObject({connected_account_id:account.id,arguments:{ref:connector.supabase_project_ref}});
});

test('does not look up external facts for an unverified live account',async()=>{
  const lookup = jest.mocked(loadExternalDataset); lookup.mockClear();
  const f=fixture();f.queue(f.tool,f.toolkit,{...f.account,user_id:randomUUID()});
  await expect(describeConnectorTool(f.input)).rejects.toMatchObject({code:'CONNECTOR_ACCOUNT_MISMATCH'});
  expect(lookup).not.toHaveBeenCalled();noPost();
});

test('rejects drift in local provider contract, defaults, aliases, tags and scope', () => {
  const { tool } = fixture(); const schema = tool.input_parameters; const props = schema.properties;
  for (const changes of [{ slug: 'SUPABASE_SELECT_FROM_TABLE' }, { version: '20270101_00' }, { tags: [...tool.tags, 'createHint'] },
    { tags: ['readOnlyHint'] }, { tags: Array(4).fill('readOnlyHint') }, { scopes: ['Database:Read'] }, { scopes: ['database_read', '*'] },
    { scope_requirements: {} }, { no_auth: true }, { input_parameters: { ...schema, properties: { ...props, sql: props.query } } },
    { input_parameters: { ...schema, properties: { ...props, parameters: { type: 'array', items: { type: 'object' } } } } },
    { input_parameters: { ...schema, properties: { ...props, query: { type: 'string', default: 'different' } } } },
    { input_parameters: { ...schema, additionalProperties: true } }, { input_parameters: { ...schema, required: ['ref'] } }]) {
    expect(() => assertReportContract({ ...tool, ...changes })).toThrow();
  }
});

test('no unconstrained SQL, project, offset, aliases, foreign schema, identifier truncation or case folding', () => {
  for (const args of [{ ref: 'a'.repeat(20) }, { query: 'example' }, { project_ref: 'example' }, { sql: 'example' }, { parameters: [] },
    { schema: 'public' }, { limit: 0 }, { limit: 26 }, { limit: 1.2 }, { limit: '2' }, { offset: 0 }, ...['public.sales', 'Sales', 'sales\n',
      'foreign"', 'sales;select', '', 'pg_class', 'a'.repeat(64), null, 1].map(view => ({ view }))]) expect(() => reportRequest(args)).toThrow();
  const { input } = fixture();
  for (const site_id of [randomUUID()+'\n', 'unsafe', 'A'.repeat(36)]) expect(() => reportBinding({ ...input.connector, site_id })).toThrow();
  for (const supabase_project_ref of [null, ' ', 'x'.repeat(21)]) expect(() => reportBinding({ ...input.connector, supabase_project_ref })).toThrow();
});

test('checked empty, unavailable, and bounded results; raw data, secrets and foreign frames never escape', () => {
  const { input, frame } = fixture(); const { connector, credential } = input;
  const project = (v: unknown, args = {} as Record<string, unknown>) => projectSupabaseCatalogResult(v, connector, args, credential.apiKey);
  expect(project(frame(null, []))).toMatchObject({ views: [], guidance: expect.stringContaining('administrator') });
  expect(project(JSON.stringify(frame(null, ['monthly_sales'])))).toMatchObject({ views: ['monthly_sales'] });
  expect(project(frame('sales', null), { view: 'sales' })).toMatchObject({ status: 'not_available', guidance: expect.any(String) });
  expect(project(frame('sales', []), { view: 'sales' })).toMatchObject({ rows: [] });
  const pat = `sbp_${secret()}`;
  for (const bad of [[], '{}', { rows: frame('sales', []) }, frame(null, []), [{ ...frame('sales', [])[0], report_schema: 'other' }],
    [...frame('sales', []), ...frame('sales', [])], frame('sales', Array(11).fill({ label: 'OK', value: '1' })),
    frame('sales', [{ label: 'OK', value: '1', debug: pat }]), frame('sales', [{ label: 'OK', value: '1e2000' }]),
    ...[credential.apiKey, pat, `Bearer ${secret()}`, { data: pat }, 'https://example.invalid', 'line\nwrap'].map(label => frame('sales', [{label,value:'1'}]))]) {
    let err; try { project(bad, { view: 'sales' }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'CONNECTOR_RESULT_UNSUPPORTED' }); expect(String(err)).not.toContain(pat); expect(String(err)).not.toContain(credential.apiKey);
  }
});


test('publishes explicit inventory coverage, validates continuation and retains exact bigint/decimal text', () => {
  const {input,frame} = fixture();
  const project = (view: string | null, rows: unknown[], args: Record<string,unknown>) =>
    projectSupabaseCatalogResult(frame(view,rows),input.connector,args,input.credential.apiKey);
  expect(project(null,['annual','daily','monthly'],{limit:2})).toMatchObject({views:['annual','daily'],has_more:true,next_after:'daily'});
  expect(project(null,['monthly'],{after:'daily',limit:2})).toMatchObject({views:['monthly'],has_more:false,next_after:null});
  expect(project(null,[],{after:'monthly'})).toMatchObject({views:[],has_more:false,guidance:expect.stringContaining('No more')});
  for(const invalid of [{after:'pg_class'},{after:'pg_secret'},{after:'public.other'},{view:'weekly',after:'daily'}]) expect(()=>reportRequest(invalid)).toThrow();
  expect(()=>project(null,['annual'],{after:'daily'})).toThrow();
  for(const value of ['9223372036854775807','-9223372036854775808','0.000000000000000001']) {
    expect(project('sales',[{label:'Total',value}],{view:'sales'})).toMatchObject({rows:[{label:'Total',value}]});
  }
});


// Public schema snapshot, not an authenticated execution capture. Use the documented REST
// success envelope with one server-produced SQL frame; never assume arbitrary nested rows.
it('accepts the published release and validates its explicit result wrapper at dispatch', async () => {
  const f=fixture(); const tool={...f.tool,...publishedContract};
  f.queue(tool,f.toolkit,f.account); const descriptor=await describeConnectorTool(f.input);
  // A saved report choice carries the original full catalog-read-v1 pin, not a hash of
  // the latest public JSON projection. Never re-describe or weaken that pin to open it.
  const {connector,provider}=f.input;
  const savedPin=hashConnectorSchema({ mode:'catalog-read-v1', contractHash:hashConnectorSchema(tool),
    model:reportModelSchema(), binding:reportBinding(connector), connector:connector.id, site:connector.site_id,
    project:provider.project_id, account:connector.provider_account_id, authConfig:connector.auth_config_id,
    revision:provider.credential_revision, providerId:provider.id });
  expect(descriptor.schemaHash).toBe(savedPin);
  expect(descriptor.inputSchema).toEqual(reportModelSchema());
  const frame=f.frame('sales',[{label:'USD',value:'91.25'}]);
  f.queue(tool,f.toolkit,f.account,{successful:true,error:null,data:{result:frame,rows_returned:1}});
  const result=await executeConnectorTool({...f.input,input:{view:'sales'},allowedTools:[tool.slug],schemaHash:savedPin,
    toolkitVersion:descriptor.toolkitVersion,requiredScopes:['database_read'],beforeDispatch:async()=>undefined});
  expect(result.data).toMatchObject({rows:[{label:'USD',value:'91.25'}]});
  for(const invalid of [{result:frame,rows_returned:2},{result:frame,rows_returned:1,diagnostic:'noise'},{result:[]},
    {data:{result:frame,rows_returned:1}}, {result:f.frame('not_sales',[])}]) {
    expect(()=>projectSupabaseCatalogResult(invalid,f.input.connector,{view:'sales'},f.input.credential.apiKey)).toThrow();
  }
});
