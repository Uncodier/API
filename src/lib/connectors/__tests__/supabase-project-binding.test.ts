import { randomUUID } from 'node:crypto';
import { POST } from '@/app/api/connectors/connections/[id]/bind-project/route';
import { bindSupabaseProject } from '../supabase-project-binding';
import { getReviewedTool } from '../reviewed-tools';
import { ConnectorError } from '../types';
import { accountFixture, connectorFixture, providerFixture, secret, toolFixture } from './composio-fixtures';

const rpc = jest.fn(), getUser = jest.fn(), manager = jest.fn(), visible = jest.fn(), credential = jest.fn(), provider = jest.fn(), request = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: (...a: unknown[]) => getUser(...a) }, rpc: (...a: unknown[]) => rpc(...a) } }));
jest.mock('../access', () => ({ ...jest.requireActual('../access'), requireConnectorSiteAccess: (...a: unknown[]) => manager(...a),
  getVisibleConnector: (...a: unknown[]) => visible(...a), loadConnectorCredential: (...a: unknown[]) => credential(...a), getConnectorProvider: (...a: unknown[]) => provider(...a) }));
jest.mock('../provider-binding', () => ({ readTokenProviderBinding: () => ({ projectId: 'project_one' }) }));
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'), createComposioClient: () => ({ request }) }));
const actor = randomUUID(), site = randomUUID(), id = randomUUID();
const project = 'a'.repeat(20), key = secret(), rev = 'credential-revision', version = '20261116_00', slug = 'SUPABASE_GET_PROJECT';
const input = { site_id: site, expected_revision: 1, project_ref: project };
const connector = { ...connectorFixture(), id, site_id: site, toolkit_slug: 'supabase', supabase_project_ref: null, display_name: 'Supabase · ' + 'b'.repeat(20) };
const account = { ...accountFixture(), toolkit: { slug: 'supabase' }, user_id: site, data: { base_url: 'https://api.supabase.com' }, state: { authScheme: 'API_KEY', val: { full: 'http...' } } };
const tool = { ...toolFixture(), scopes: ['projects:read'], slug, version, toolkit: account.toolkit, input_parameters: { type: 'object', required: ['ref'], properties: { ref: { type: 'string', title: 'Ref', pattern: '^[a-z]+$', minLength: 20, maxLength: 20, examples: [project] } } } };
const projectData = { id: project, ref: project, organization_id: 'org' };
const success = { successful: true, error: null, data: projectData };
const bind = () => bindSupabaseProject(actor, id, input);
function route(body: unknown, authenticated = true) {
  return POST(new Request('https://api.example.test/bind-project', { method: 'POST', headers: { 'content-type': 'application/json',
    ...(authenticated ? { authorization: `Bearer ${key}` } : {}), 'x-user-id': id }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}
beforeEach(() => {
  jest.resetAllMocks(); getUser.mockResolvedValue({ data: { user: { id: actor } } }); manager.mockResolvedValue({ can_manage: true });
  visible.mockResolvedValue(connector); credential.mockResolvedValue({ revision: rev, apiKey: key });
  provider.mockResolvedValue({ ...providerFixture(), site_id: site, provider_user_id: site, credential_revision: rev });
  rpc.mockReturnValue({ abortSignal: async () => ({ data: { connector_id: id, revision: 2 } }) });
});

test('only the authenticated manager can pin a single project read to the existing owner/account/version; only a local receipt leaves the route', async () => {
  request.mockResolvedValueOnce(tool).mockResolvedValueOnce(account).mockResolvedValueOnce({ ...success, data: { ...projectData, database: key } });
  const response = await route(input);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ connector_id: id, revision: 2 });
  expect(manager).toHaveBeenCalledWith(site, actor, true); expect(visible).toHaveBeenCalledWith(site, actor, id);
  expect(request.mock.calls).toEqual([[`/tools/${slug}?version=${version}`], [`/connected_accounts/${account.id}`],
    [`/tools/execute/${slug}`, { method: 'POST', body: { user_id: site, connected_account_id: account.id, version, arguments: { ref: project } } }]]);
  expect(rpc.mock.calls).toEqual([['connector_bind_supabase_project', { p_site_id: site, p_connector_id: id, p_actor_id: actor,
    p_expected_revision: 1, p_project_ref: project, p_credential_revision: rev }]]);
  expect(() => getReviewedTool(slug, 'supabase')).toThrow();
});

test('denies unverified actor, nonmanager and injected parameters before any provider contact', async () => {
  expect((await route(input, false)).status).toBe(401);
  for (const extra of [{ actor }, { connected_account_id: account.id }, { version }, { project_ref: project + '\n' }, { project_ref: '1'.repeat(20) }]) {
    expect((await route({ ...input, ...extra })).status).toBe(400);
  }
  manager.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED', 'Denied', 403));
  expect((await route(input)).status).toBe(403); expect(visible).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});

test.each([{ toolkit_slug: 'other' }, { supabase_project_ref: project }, { supabase_project_ref: undefined }, { provider_status: 'REVOKED' },
  { provider_account_id: 'instant_account' }, { enabled: false }, { revocation_pending: true }, { verified_at: null }, { revision: 2 }])('rejects ineligible existing row %p before provider I/O', async change => {
  visible.mockResolvedValue({ ...connector, ...change }); await expect(bind()).rejects.toThrow(); expect(request).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});

test.each([{ version: 'latest' }, { slug: slug + '_API_KEY' }, { toolkit: { slug: 'other' } }, { no_auth: true }, { is_deprecated: true }, { scopes: ['projects:write'] }, { scope_requirements: {} },
  { input_parameters: { ...tool.input_parameters, properties: { ref: { type: 'string' }, url: { type: 'string' } } } }])('rejects descriptor drift %p', async change => {
  request.mockResolvedValueOnce({ ...tool, ...change }); await expect(bind()).rejects.toMatchObject({ code: 'SUPABASE_BIND_SCHEMA' }); expect(request).toHaveBeenCalledTimes(1); expect(rpc).not.toHaveBeenCalled();
});

test.each([{ user_id: 'other' }, { id: 'other' }, { toolkit: { slug: 'other' } }, { status: 'INACTIVE' }, { experimental: { account_type: 'SHARED' } },
  { auth_config: { ...account.auth_config, id: 'other' } }, { is_disabled: true }, { state: { ...account.state, authScheme: 'OAUTH2' } },
  { data: {} }, { data: { base_url: 'https://api.supabase.com.example.test' } },
  { data: { base_url: 'https://example.test' }, state: { ...account.state, val: { full: 'https://api.supabase.com' } } },
  { state: { ...account.state, val: { full: 'https://api.supabase.com.example.test' } } }])('rejects provider identity mismatch %p without a project probe', async change => {
  request.mockResolvedValueOnce(tool).mockResolvedValueOnce({ ...account, ...change }); await expect(bind()).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(2); expect(rpc).not.toHaveBeenCalled();
});

test.each([{ successful: false }, { error: 'denied' }, { data: { ref: project } }, { data: { name: project } },
  { data: { ...projectData, ref: 'b'.repeat(20) } }, { data: { ...projectData, id: 'other' } }])('fails closed on unsuccessful, partial or mismatched metadata proof %p', async change => {
  request.mockResolvedValueOnce(tool).mockResolvedValueOnce(account).mockResolvedValueOnce({ ...success, ...change });
  await expect(bind()).rejects.toMatchObject({ code: 'data' in change ? 'SUPABASE_BIND_IDENTITY' : 'SUPABASE_BIND_READ' }); expect(rpc).not.toHaveBeenCalled();
});

test('rechecks manager/revision before dispatch and credential after proof; never retries a CAS failure', async () => {
  visible.mockResolvedValueOnce(connector).mockResolvedValueOnce({ ...connector, revision: 2 });
  request.mockResolvedValueOnce(tool).mockResolvedValueOnce(account);
  await expect(bind()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValueOnce(tool).mockResolvedValueOnce(account).mockResolvedValueOnce(success);
  credential.mockResolvedValueOnce({ revision: rev, apiKey: key }).mockResolvedValueOnce({ revision: rev }).mockResolvedValueOnce({ revision: 'rotated' });
  await expect(bind()).rejects.toMatchObject({ code: 'PROVIDER_REVALIDATION_REQUIRED' }); expect(rpc).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(tool).mockResolvedValueOnce(account).mockResolvedValueOnce(success);
  rpc.mockReturnValueOnce({ abortSignal: async () => ({ error: { code: '40001' } }) });
  await expect(bind()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(rpc).toHaveBeenCalledTimes(1);
});
