import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { reviewedInputSchema } from '../reviewed-tool-schema';
import { projectTableNames } from '../supabase-table-result';
import { compatibleReviewedTools, getReviewedTool, policyReviewedTools } from '../reviewed-tools';
import { canRequestFromConversation, conversationReviewSlugs } from '../reviewed-tools';
import { scopesAllowed, screenAllowed } from '../action-policy';
import { validateConnectorInput } from '../schema-validation';
import { accountFixture, connectorFixture, providerFixture, secret, toolFixture, jsonResponse } from './composio-fixtures';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
const slug = 'SUPABASE_LIST_TABLES';
const ref = 'a'.repeat(20);
const provider = providerFixture();
const connector = { ...connectorFixture(), toolkit_slug: 'supabase', supabase_project_ref: ref, granted_scopes: [] };
const policy = { allowed_tools: [], tool_access_mode: 'all' as const, allowed_hosts: ['assistant'], require_approval: true };
const schema = { type: 'object', required: ['project_ref'], properties: {
  project_ref: { type: 'string', pattern: '^[a-z]+$', minLength: 20, maxLength: 20, examples: [ref] }, schemas: { type: 'array', items: { type: 'string' } },
  include_views: { type: 'boolean', default: true }, include_metadata: { type: 'boolean', default: true }, include_system_schemas: { type: 'boolean', default: false },
} };
const tool = { ...toolFixture(), slug, toolkit: { slug: 'supabase' }, input_parameters: schema, scopes: ['Database:Read'] };
const account = { ...accountFixture(), toolkit: tool.toolkit, state: { authScheme: 'API_KEY', val: { full: 'https://api.supabase.com' } } };
const base = () => ({ credential: { apiKey: secret(), revision: provider.credential_revision }, connector, provider, toolSlug: slug });
const original = global.fetch;
const request = jest.fn();
beforeEach(() => { request.mockReset(); global.fetch = request; });
afterEach(() => { global.fetch = original; });
async function prepared() {
  const input = base(); request.mockResolvedValueOnce(jsonResponse(tool));
  const descriptor = await describeConnectorTool(input); request.mockClear();
  return { ...input, toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash,
    allowedTools: [slug], requiredScopes: ['Database:Read'], beforeDispatch: jest.fn(async () => undefined), input: {} };
}

test('compatible only with the trusted project field, DB screen, authorized policy and the narrow PAT permission', () => {
  const reviewed = getReviewedTool(slug, 'supabase');
  expect(policyReviewedTools(connector, policy)).toEqual([reviewed]);
  expect(policyReviewedTools(connector, { ...policy, tool_access_mode: 'selected' })).toEqual([]);
  expect(scopesAllowed(connector, reviewed)).toBe(true);
  expect(scopesAllowed({ ...connector, granted_scopes: ['secrets:read'] }, reviewed, ['secrets:read'])).toBe(false);
  expect(screenAllowed(reviewed, { isAdmin: false, blockedScreens: ['applicationsDatabase'] })).toBe(false);
  expect(screenAllowed(reviewed, { isAdmin: false, blockedScreens: ['connectors'] })).toBe(false);
  expect(canRequestFromConversation(slug)).toBe(false); expect(conversationReviewSlugs).not.toContain(slug);
  for (const project of [null, undefined, 'a'.repeat(19), 'A'.repeat(20), '1'.repeat(20)]) {
    const old = { ...connector, supabase_project_ref: project, display_name: `Supabase · ${ref}` };
    expect(compatibleReviewedTools(old)).toEqual([]);
    expect(scopesAllowed(old, reviewed)).toBe(false);
  }
});

test('describe fails before provider contact with no binding; public schema never exposes provider options', async () => {
  await expect(describeConnectorTool({ ...base(), connector: { ...connector, supabase_project_ref: null } })).rejects.toMatchObject({ code: 'CONNECTOR_PROJECT_UNBOUND' });
  expect(request).not.toHaveBeenCalled();
  const model = reviewedInputSchema(slug, schema);
  expect(model).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  expect(() => validateConnectorInput(model, { project_ref: ref })).toThrow();
  for (const changed of [{ ...schema.properties, include_metadata: { type: 'string' } }, { ...schema.properties, url: { type: 'string' } },
    { ...schema.properties, schemas: { ...schema.properties.schemas, default: ['public'] } }, { project_ref: { type: 'string' } }]) {
    expect(() => reviewedInputSchema(slug, { ...schema, properties: changed })).toThrow();
  }
});

test('pins exact private account/version/verified project; strips row data, diagnostics and secrets', async () => {
  const input = await prepared(); const privateValue = secret();
  request.mockResolvedValueOnce(jsonResponse(tool)).mockResolvedValueOnce(jsonResponse(account)).mockResolvedValueOnce(jsonResponse({
    successful: true, error: null, log_id: privateValue, data: { tables: [{ table_schema: 'public', table_name: 'Orders', rows: [privateValue], table_size: 200 },
      { schema: 'billing', name: 'Orders' }], schema_errors: { private: privateValue }, token: privateValue },
  }));
  const result = await executeConnectorTool(input);
  expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ user_id: provider.provider_user_id, connected_account_id: account.id,
    version: tool.version, arguments: { project_ref: ref, include_views: false, include_metadata: false, include_system_schemas: false } });
  expect(request.mock.calls[2][0]).toMatch(/\/tools\/execute\/SUPABASE_LIST_TABLES$/);
  expect(result.data).toEqual({ tables: [{ schema: 'public', name: 'Orders' }, { schema: 'billing', name: 'Orders' }], coverage: expect.stringMatching(/Partial/) });
  expect(JSON.stringify(result)).not.toContain(privateValue); expect(input.beforeDispatch).toHaveBeenCalledTimes(1);
});

test('projects only names from the grouped Composio response without replay', async () => {
  const input = await prepared(); const diagnostic = secret();
  const data = { tables: null, schemas: [
    { schema_name: 'empty', tables: [] },
    { schema_name: 'sales', tables: [{ schema_name: 'sales', table_name: 'orders', table_type: 'BASE TABLE', comment: diagnostic }] },
  ], query_metadata: { errors: null } };
  request.mockResolvedValueOnce(jsonResponse(tool)).mockResolvedValueOnce(jsonResponse(account)).mockResolvedValueOnce(jsonResponse({
    successful: true, successfull: true, error: null, data, logs: [diagnostic],
  }));
  const result = await executeConnectorTool(input);
  expect(result).toEqual({ successful: true, data: { tables: [{ schema: 'sales', name: 'orders' }], coverage: expect.stringMatching(/can be partial/) } });
  expect(request).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(result)).not.toContain(diagnostic);
  expect(projectTableNames({ ...data, query_metadata: { errors: [diagnostic] } }).coverage).toMatch(/^Partial:/);
});

test('rejects malformed schema groups and inconsistent table membership', () => {
  for (const group of [null, { schema_name: 'sales', tables: null },
    { schema_name: 'sales', tables: [{ schema_name: 'other', table_name: 'orders' }] },
    { schema_name: 'sales', tables: [{ schema_name: 'sales', table_name: 'summary', table_type: 'VIEW' }] }]) {
    expect(() => projectTableNames({ tables: null, schemas: [group] })).toThrow();
  }
});

test('direct adapter denies caller overrides, missing binding, foreign origin/identity/scheme and scope drift', async () => {
  const input = await prepared();
  for (const args of [{ project_ref: ref }, { schemas: [] }, { include_metadata: true }, { sql: 'SELECT 1' }]) {
    await expect(executeConnectorTool({ ...input, input: args })).rejects.toMatchObject({ effectStarted: false });
  }
  await expect(executeConnectorTool({ ...input, connector: { ...connector, supabase_project_ref: null } })).rejects.toMatchObject({ effectStarted: false });
  await expect(executeConnectorTool({ ...input, toolSlug: 'SUPABASE_BETA_RUN_SQL_QUERY', allowedTools: ['SUPABASE_BETA_RUN_SQL_QUERY'] })).rejects.toMatchObject({ code: 'TOOL_UNREVIEWED', effectStarted: false });
  expect(request).not.toHaveBeenCalled();
  for (const override of [{ state: { ...account.state, authScheme: 'OAUTH2' } }, { state: { ...account.state, val: { full: 'https://test.invalid' } } },
    { state: { authScheme: 'API_KEY', val: {} } }, { user_id: 'foreign' }]) {
    request.mockResolvedValueOnce(jsonResponse(tool)).mockResolvedValueOnce(jsonResponse({ ...account, ...override }));
    await expect(executeConnectorTool(input)).rejects.toMatchObject({ effectStarted: false });
  }
  for (const changed of [{ ...tool, scopes: [] }, { ...tool, scopes: ['Database:Read', 'secrets:read'] }, { ...tool, scope_requirements: {} }]) {
    request.mockResolvedValueOnce(jsonResponse(changed));
    await expect(executeConnectorTool(input)).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_UNSUPPORTED', effectStarted: false });
  }
  expect(input.beforeDispatch).not.toHaveBeenCalled();
});

test('never treats rows or unrecognized/unsafe results as a complete table list', () => {
  const opaque = secret();
  for (const data of [{ rows: [opaque] }, { tables: [opaque] }, { tables: [{ name: 'only_name' }] },
    { tables: { pg_catalog: ['spec'] } }, { tables: [{ schema: 'public', name: 'v', type: 'view' }] },
    { tables: [{ schema: 'public', name: 'bad\nname' }] }, { tables: { public: Array(3001).fill('n') } }]) {
    expect(() => projectTableNames(data)).toThrow();
  }
  expect(projectTableNames({ tables: { public: ['résumé'], other: ['résumé'] } }).tables).toEqual([{ schema: 'public', name: 'résumé' }, { schema: 'other', name: 'résumé' }]);
  expect(projectTableNames({ tables: [] }).coverage).toMatch(/can be partial/);
});
