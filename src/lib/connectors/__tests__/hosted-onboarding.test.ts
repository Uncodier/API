import { readAuthConfigs, resolveHostedAuthConfig } from '../auth-config-provisioning';
import { getToolkit } from '../composio-catalog';
import type { ComposioClient } from '../composio-transport';
import { connectionSetup as setup, existingSetupKey } from '../connection-onboarding';
import { ConnectorError } from '../types';
import { toolkitFixture, secret } from './composio-fixtures';

const acquire = jest.fn();
const release = jest.fn();
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: (...args: unknown[]) => acquire(...args), releaseLock: (...args: unknown[]) => release(...args) }));

const request = jest.fn();
const client: ComposioClient = { request };
const recheck = jest.fn();
const project = 'project-one';
const slug = 'metaads';
const app = { mode: 'OAUTH2', is_default: true, managed_app_id: 'app_meta', scopes: { available: ['ads_read', 'ads_management'] } };
const method = (mode: string, required: unknown[] = []) => ({
  mode, fields: { auth_config_creation: { required, optional: [] }, connected_account_initiation: { required: [{ name: 'credential' }] } },
});
const config = (toolkit = slug, scheme = 'OAUTH2', extra: object = {}) => ({
  id: 'ac_available', name: 'Auth config', toolkit: { slug: toolkit }, auth_scheme: scheme, status: 'ENABLED', ...extra,
});
const managedConfig = { is_composio_managed: true, managed_app_id: 'app_meta' };
const meta = { auth_schemes: ['OAUTH2', 'API_KEY'], composio_managed_auth: [app], auth_config_details: [method('API_KEY')] };

beforeEach(() => {
  jest.resetAllMocks();
  acquire.mockResolvedValue({ state: 'acquired', token: 'lock-owner' });
});

const revision = 'project-revision';
const connectionSetup = (toolkit: Parameters<typeof setup>[0], configs: Parameters<typeof setup>[1]) => setup(toolkit, configs, revision);
function expected(toolkit: Parameters<typeof setup>[0]) {
  const current = connectionSetup(toolkit, []);
  return { key: current.setup_key ?? '0'.repeat(64), revision };
}
let toolkitResponse: object;
async function detail(id: string, patch: object) {
  toolkitResponse = { ...toolkitFixture(), slug: id, enabled: true, ...patch };
  request.mockResolvedValueOnce(toolkitResponse);
  return getToolkit(client, id);
}

function provision(item: ReturnType<typeof config>, raw?: unknown) {
  request.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce(toolkitResponse).mockResolvedValueOnce(raw ?? {
    toolkit: item.toolkit, auth_config: { id: item.id, auth_scheme: item.auth_scheme, is_composio_managed: false },
  }).mockResolvedValueOnce({ items: [item] });
}

it('provisions managed Meta OAuth on demand, not the API key, without requesting the advertised scope ceiling', async () => {
  const toolkit = await detail(slug, meta);
  expect(connectionSetup(toolkit, [])).toEqual({ kind: 'managed_oauth', auth_scheme: 'OAUTH2', setup_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(request).toHaveBeenCalledTimes(1);
  provision(config(slug, 'OAUTH2', managedConfig), { toolkit: { slug }, auth_config: { id: 'ac_available', auth_scheme: 'OAUTH2', ...managedConfig } });
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).resolves.toMatchObject({ id: 'ac_available', authScheme: 'OAUTH2' });
  expect(request).toHaveBeenNthCalledWith(4, '/auth_configs', { method: 'POST', body: {
    toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth', name: 'Makinari metaads (OAUTH2)', managed_app_id: 'app_meta', credentials: {} },
  } });
  expect(recheck.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[3]);
  expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0], 'lock-owner');
});

it.each([['API_KEY', 'hosted_credentials'], ['BASIC', 'hosted_credentials'], ['BEARER_TOKEN', 'hosted_credentials'], ['DCR_OAUTH', 'dynamic_oauth']])
('provisions %s using empty project fields and leaves account fields to the hosted link', async (scheme, kind) => {
  const toolkit = await detail('_example', { auth_schemes: [scheme], auth_config_details: [method(scheme)] });
  expect(connectionSetup(toolkit, [])).toEqual({ kind, auth_scheme: scheme, setup_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  provision(config('_example', scheme));
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).resolves.toMatchObject({ id: 'ac_available', authScheme: scheme });
  expect(request).toHaveBeenNthCalledWith(4, '/auth_configs', { method: 'POST', body: {
    toolkit: { slug: '_example' }, auth_config: { type: 'use_custom_auth', authScheme: scheme, name: `Makinari _example (${scheme})`, credentials: {} },
  } });
});

it.each([
  [{ auth_schemes: ['OAUTH2'], auth_config_details: [method('OAUTH2', [{ name: 'client_id' }])] }, 'admin_oauth', 'AUTH_CONFIG_ADMIN_REQUIRED'],
  [{ auth_schemes: ['NO_AUTH'] }, 'no_auth', 'AUTH_NOT_REQUIRED'],
  [{ auth_schemes: ['API_KEY'], auth_config_details: [method('API_KEY', [{ name: 'app_token' }])] }, 'admin_setup', 'AUTH_CONFIG_ADMIN_REQUIRED'],
  [{ auth_schemes: ['API_KEY'], auth_config_details: [{ mode: 'API_KEY' }] }, 'admin_setup', 'AUTH_CONFIG_ADMIN_REQUIRED'],
  [{ auth_schemes: ['S2S_OAUTH2'], auth_config_details: [method('S2S_OAUTH2')] }, 'admin_setup', 'AUTH_CONFIG_ADMIN_REQUIRED'],
  [{ ...meta, enabled: false }, 'unavailable', 'CONNECTOR_SETUP_UNAVAILABLE'],
])('never creates a config for an unsupported or unnecessary path (%#)', async (patch, kind, code) => {
  const toolkit = await detail(slug, patch);
  expect(connectionSetup(toolkit, [])).toEqual({ kind });
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code });
  expect(acquire).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps Calendar read-only, requires a single default app, and preserves the separate Supabase token path', async () => {
  const scope = 'https://www.googleapis.com/auth/calendar.events.readonly';
  const calendar = await detail('googlecalendar', { composio_managed_auth: [{ ...app, scopes: { available: [scope, 'write'] } }] });
  expect(connectionSetup(calendar, [])).toEqual({ kind: 'managed_oauth', auth_scheme: 'OAUTH2', setup_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  provision(config('googlecalendar', 'OAUTH2', managedConfig), { toolkit: { slug: 'googlecalendar' }, auth_config: { id: 'ac_available', auth_scheme: 'OAUTH2', ...managedConfig } });
  await resolveHostedAuthConfig(client, project, calendar, [], undefined, expected(calendar), recheck);
  expect(request.mock.calls[3][1].body.auth_config.credentials).toEqual({ scopes: scope });
  const ambiguous = await detail(slug, { auth_schemes: ['OAUTH2'], composio_managed_auth: [app, { ...app, managed_app_id: 'app_other' }] });
  expect(connectionSetup(ambiguous, [])).toEqual({ kind: 'admin_oauth' });
  const unpinned = await detail(slug, { ...meta, composio_managed_auth: [{ ...app, managed_app_id: undefined }] });
  expect(connectionSetup(unpinned, [])).toEqual({ kind: 'admin_oauth' });
  const supabase = await detail('supabase', meta);
  expect(connectionSetup(supabase, [])).toEqual({ kind: 'supabase_token' });
});

it('reuses an explicit private enabled config and never silently substitutes another config', async () => {
  const toolkit = await detail(slug, meta);
  request.mockResolvedValueOnce({ items: [config(), config(slug, 'API_KEY', { id: 'ac_other' })] });
  const configs = await readAuthConfigs(client, slug, true);
  expect(connectionSetup(toolkit, configs)).toEqual({ kind: 'existing', config_ids: ['ac_available', 'ac_other'] });
  await expect(resolveHostedAuthConfig(client, project, toolkit, configs, undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  await expect(resolveHostedAuthConfig(client, project, toolkit, configs, 'ac_missing', expected(toolkit), recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  await expect(resolveHostedAuthConfig(client, project, toolkit, configs, 'ac_other', { key: existingSetupKey(revision, toolkit, configs[1]), revision }, recheck)).resolves.toMatchObject({ id: 'ac_other' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(acquire).not.toHaveBeenCalled();
});

it.each([{ status: 'DISABLED' }, { proxy_config: {} }, { shared_connection_fields: { credential: secret() } }])
('does not shadow a disabled or shared config that appears after the first read (%#)', async extra => {
  const toolkit = await detail(slug, meta);
  request.mockResolvedValueOnce({ items: [config(slug, 'OAUTH2', extra)] });
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_ADMIN_REQUIRED' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(recheck).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([config(), config(slug, 'OAUTH2', managedConfig), config(slug, 'API_KEY')])('requires fresh confirmation when a config appears under the project lock (%#)', async appeared => {
  const toolkit = await detail(slug, meta);
  request.mockResolvedValueOnce({ items: [appeared] });
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  expect(release).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(acquire.mock.calls[0][0]).toMatch(/^[^:]+:oauth-setup:v1:[a-f0-9]{64}:metaads$/);
});

it('stops when the lock is contended or permission is withdrawn before the provider write', async () => {
  const toolkit = await detail(slug, meta);
  acquire.mockResolvedValueOnce({ state: 'contended' });
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_PENDING' });
  request.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce(toolkitResponse);
  recheck.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED', 'Denied', 403));
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(request).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledTimes(1);
});

it('does not retry or release the lease on an unverified provider write', async () => {
  const toolkit = await detail(slug, meta);
  provision(config(slug, 'OAUTH2', { ...managedConfig, managed_app_id: 'unexpected' }), {
    toolkit: { slug }, auth_config: { id: 'ac_available', auth_scheme: 'OAUTH2', ...managedConfig },
  });
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(release).not.toHaveBeenCalled();
});

it('requires positive account-field metadata for credentials, ignoring hidden fields and inherited values', async () => {
  const scheme = 'API_KEY';
  const fields = method(scheme);
  for (const required of [[], [{ name: 'credential', required: true, user_visible: false }]]) {
    const toolkit = await detail(slug, { auth_schemes: [scheme],
      auth_config_details: [{ ...fields, fields: { ...fields.fields, connected_account_initiation: { required } } }] });
    expect(connectionSetup(toolkit, [])).toEqual({ kind: 'admin_setup' });
  }
  const toolkit = await detail(slug, { auth_schemes: [scheme] });
  request.mockResolvedValueOnce({ items: [config(slug, scheme, { expected_input_fields: [{ name: 'key', required: true, user_visible: true }] })] });
  const configs = await readAuthConfigs(client, slug);
  expect(connectionSetup(toolkit, configs)).toEqual({ kind: 'existing', config_ids: ['ac_available'] });
  expect(connectionSetup(toolkit, [{ ...configs[0], hasConfigCredentials: true }])).toEqual({ kind: 'admin_setup' });
});
it.each([[], null, { invalid: true }, [{ name: 'private', user_visible: false }], [{ name: 'optional', required: false }]].map(override => ({ override })))
('does not let toolkit field metadata override explicit config-specific metadata (%#)', async ({ override }) => {
  const toolkit = await detail(slug, { auth_schemes: ['API_KEY'], auth_config_details: [method('API_KEY')] });
  request.mockResolvedValueOnce({ items: [config(slug, 'API_KEY', { expected_input_fields: override }), config(slug, 'API_KEY', { id: 'ac_inherits_toolkit' })] });
  const configs = await readAuthConfigs(client, slug);
  expect(connectionSetup(toolkit, configs)).toEqual({ kind: 'existing', config_ids: ['ac_inherits_toolkit'] });
});

it.each([
  { ...meta, composio_managed_auth: [{ ...app, managed_app_id: 'different_app' }] },
  { auth_schemes: ['API_KEY'], auth_config_details: [method('API_KEY')] },
])('rejects discovery-to-start or under-lock automatic method/app drift before writing (%#)', async changed => {
  const original = await detail(slug, meta);
  const confirmed = expected(original);
  const latest = await detail(slug, changed);
  await expect(resolveHostedAuthConfig(client, project, latest, [], undefined, confirmed, recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  expect(acquire).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce(toolkitResponse);
  await expect(resolveHostedAuthConfig(client, project, original, [], undefined, confirmed, recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  expect(release).toHaveBeenCalledTimes(1);
  expect(recheck).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('binds an existing config to the confirmed scheme, managed app, display name and project credential revision', async () => {
  const toolkit = await detail(slug, meta);
  request.mockResolvedValueOnce({ items: [config(slug, 'OAUTH2', managedConfig)] });
  const [chosen] = await readAuthConfigs(client, slug);
  const key = existingSetupKey(revision, toolkit, chosen);
  for (const drift of [{ authScheme: 'API_KEY' }, { managedAppId: 'other_app' }, { isManaged: false }, { name: 'different' }]) {
    await expect(resolveHostedAuthConfig(client, project, toolkit, [{ ...chosen, ...drift }], chosen.id, { key, revision }, recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  }
  await expect(resolveHostedAuthConfig(client, project, toolkit, [chosen], chosen.id, { key, revision: 'changed' }, recheck)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(acquire).not.toHaveBeenCalled();
});

it.each([
  ['PROVIDER_AUTH_CONFIG_INVALID', 'AUTH_CONFIG_PROVIDER_SETUP_REQUIRED', true],
  ['PROVIDER_REJECTED', 'CONNECTOR_OUTCOME_UNKNOWN', false],
  ['CONNECTOR_OUTCOME_UNKNOWN', 'CONNECTOR_OUTCOME_UNKNOWN', false],
])('releases only on definite create rejection, without replay (%s)', async (providerCode, publicCode, releases) => {
  const toolkit = await detail(slug, meta);
  request.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce(toolkitResponse).mockRejectedValueOnce(new ConnectorError(String(providerCode), 'Failed.'));
  await expect(resolveHostedAuthConfig(client, project, toolkit, [], undefined, expected(toolkit), recheck)).rejects.toMatchObject({ code: publicCode });
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(release).toHaveBeenCalledTimes(releases ? 1 : 0);
});
