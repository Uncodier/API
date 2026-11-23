import { randomUUID } from 'node:crypto';
import { loadConnectorCredential } from '../account-access';
import { readTokenProviderBinding } from '../provider-project-binding';
import type { CatalogOnlyAccount } from '../selected-catalog-account';
import { prepareSelectedQueryProbe } from '../selected-query-probe-transport';
import { accountFixture, connectorFixture, jsonResponse, providerFixture, secret, toolFixture, toolkitFixture } from './composio-fixtures';
import published from './fixtures/supabase-report-20261116_00.json';

jest.mock('../account-access', () => ({loadConnectorCredential: jest.fn()}));
jest.mock('../provider-project-binding', () => ({readTokenProviderBinding: jest.fn()}));
afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); });

const slug = 'SUPABASE_RUN_READ_ONLY_QUERY', version = '20261116_00';
const row = {'?column?': 1};
const success = { successful: true, error: null, data: { rows_returned: 1, result: [row] } };
function setup() {
  const site = randomUUID(), apiKey = secret(), ref = 'a'.repeat(20);
  const provider = {...providerFixture(), site_id: site, provider_user_id: site, credential_revision: secret()};
  const target: CatalogOnlyAccount = {catalogOnly: true, connector: {...connectorFixture(), id: randomUUID(), site_id: site,
    toolkit_slug: 'supabase', supabase_project_ref: ref, revocation_dispatched: false}, provider,
    policy: {catalog_reads: true, allowed_hosts: ['assistant'], tool_access_mode: 'selected', allowed_tools: [slug], require_approval: false, revision: 1}};
  const tool = {...toolFixture(), ...structuredClone(published), slug, version, toolkit: {slug: 'supabase'}, scopes: ['database_read'],
    tags: ['important', 'readOnlyHint', 'openWorldHint', 'Database']};
  const account = {...accountFixture(), toolkit: tool.toolkit, user_id: site, state: {authScheme: 'API_KEY', val: {full: 'https://api.supabase.com'}}};
  const wire = {response: success as unknown, posts: [] as unknown[], requests: [] as string[]};
  const kit = {...toolkitFixture(), slug: 'supabase'};
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey, revision: provider.credential_revision, source: 'byok'});
  jest.mocked(readTokenProviderBinding).mockResolvedValue({projectId: provider.project_id});
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
    const base = 'https://backend.composio.dev/api/v3.1';
    wire.requests.push(String(url));
    expect(new Headers(opts?.headers).get('x-api-key')).toBe(apiKey);
    if (url === `${base}/tools/${slug}?version=${version}`) return jsonResponse(tool);
    if (url === `${base}/toolkits/supabase`) return jsonResponse(kit);
    if (url === `${base}/connected_accounts/ca_one`) return jsonResponse(account);
    if (url === `${base}/tools/execute/${slug}` && opts?.method === 'POST') {
      wire.posts.push(JSON.parse(String(opts.body)));
      return jsonResponse(wire.response);
    }
    throw new Error('Unexpected upstream request');
  });
  return {target, tool, account, kit, ref, site, wire};
}

it('dispatches only literal SELECT 1 to the selected private account and server-bound project after the final check', async () => {
  const f = setup();
  f.wire.response = {...success, log_id: secret()};
  const plan = await prepareSelectedQueryProbe(f.target);
  expect(Object.keys(plan).sort()).toEqual(['execute', 'schemaHash', 'version']);
  expect(plan).toMatchObject({version, schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(f.wire.posts).toEqual([]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = plan.execute(() => gate);
  await expect(plan.execute(async () => {})).rejects.toMatchObject({code: 'ACCESS_CHANGED'});
  expect(f.wire.posts).toEqual([]);
  f.target.connector.supabase_project_ref = 'b'.repeat(20);
  f.target.connector.provider_account_id = 'ca_other';
  release();
  await expect(first).resolves.toBeUndefined();
  expect(f.wire.posts).toEqual([{connected_account_id: 'ca_one', user_id: f.site, version, arguments: {ref: f.ref, query: 'SELECT 1'}}]);
});

it('does not dispatch if reauthorization fails', async () => {
  const f = setup(), plan = await prepareSelectedQueryProbe(f.target);
  await expect(plan.execute(async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(f.wire.posts).toEqual([]);
});

it.each(['ref', 'selected tool', 'revocation', 'credential', 'project proof', 'version', 'scope', 'input schema', 'output schema',
  'account id', 'auth config', 'owner', 'private', 'hosted PAT', 'native API'])('fails closed on an invalid %s', async field => {
  const f = setup();
  switch (field) {
    case 'ref': f.target.connector.supabase_project_ref = null; break;
    case 'selected tool': f.target.policy.allowed_tools = ['OTHER']; break;
    case 'revocation': f.target.connector.revocation_dispatched = true; break;
    case 'credential': f.target.provider.credential_revision = secret(); break;
    case 'project proof': jest.mocked(readTokenProviderBinding).mockResolvedValue({projectId: 'another'}); break;
    case 'version': f.tool.version = '20261117_00'; break;
    case 'scope': f.tool.scopes.push('other'); break;
    case 'input schema': f.tool.input_parameters.properties.ref.description += 'changed'; break;
    case 'output schema': f.tool.output_parameters.title += 'changed'; break;
    case 'account id': f.account.id = 'ca_other'; break;
    case 'auth config': f.account.auth_config.id = 'ac_other'; break;
    case 'owner': f.account.user_id = randomUUID(); break;
    case 'private': f.account.experimental.account_type = 'SHARED'; break;
    case 'hosted PAT': f.account.state.val.full = 'https://other.example.test'; break;
    case 'native API': f.kit.toolkit_type = 'mcp'; break;
  }
  await expect(prepareSelectedQueryProbe(f.target)).rejects.toThrow();
  expect(f.wire.posts).toEqual([]);
  expect(f.wire.requests.join('\n')).not.toMatch(/connected_accounts\?|tool_router|proxy/);
});

it.each([
  {...success, error: 'provider detail'}, {data: success.data},
  {...success, data: [row]}, {...success, data: {...success.data, rows_returned: 0}},
  ...[[], [row, row], [{value: 1}], [{'?column?': '1'}], [{'?column?': 1, extra: 'provider detail'}]].map(result =>
    ({...success, data: {...success.data, result}})),
])('rejects unconfirmed results without returning provider diagnostics or retrying', async response => {
  const f = setup(); f.wire.response = response;
  const plan = await prepareSelectedQueryProbe(f.target);
  await expect(plan.execute(async () => {})).rejects.toMatchObject({code: 'CONNECTOR_RESULT_UNSUPPORTED', message: 'The provider did not confirm the connection test.'});
  await expect(plan.execute(async () => {})).rejects.toMatchObject({code: 'ACCESS_CHANGED'});
  expect(f.wire.posts).toHaveLength(1);
});

it('accepts an exact probe row without optional wrapper fields', async () => {
  const f = setup(); f.wire.response = { successful: true, data: { result: [row] } };
  await expect((await prepareSelectedQueryProbe(f.target)).execute(async () => {})).resolves.toBeUndefined();
  expect(f.wire.posts).toHaveLength(1);
});

it.each([
  [{successful: false, error: 'private diagnostic', data: {status_code: 403}}, 'APP_RESOURCE_DENIED'],
  [{successful: false, error: 'private diagnostic 403', data: {}}, 'CONNECTOR_READ_FAILED'],
  [{...success, successful: false}, 'CONNECTOR_READ_FAILED'],
])('preserves only structured application failures', async (response, code) => {
  const f = setup(); f.wire.response = response;
  const plan = await prepareSelectedQueryProbe(f.target);
  const error = await plan.execute(async () => {}).catch(e => e);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain('private diagnostic');
  expect(f.wire.posts).toHaveLength(1);
});
