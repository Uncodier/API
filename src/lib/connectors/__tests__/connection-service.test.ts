import { randomBytes } from 'node:crypto';
import { disconnectConnector, getConnectionSummary, listConnections, syncConnector } from '../connection-service';
import { ConnectorError } from '../types';

const rpc = jest.fn();
const from = jest.fn();
const access = jest.fn();
const visible = jest.fn();
const visibleList = jest.fn();
const credential = jest.fn();
const provider = jest.fn();
const binding = jest.fn();
const account = jest.fn();
const accounts = jest.fn();
const revoke = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...args), from: (...args: unknown[]) => from(...args) } }));
jest.mock('../access', () => ({ ...jest.requireActual('../access'),
  requireConnectorSiteAccess: (...args: unknown[]) => access(...args), getVisibleConnector: (...args: unknown[]) => visible(...args),
  listVisibleConnectors: (...args: unknown[]) => visibleList(...args), loadConnectorCredential: (...args: unknown[]) => credential(...args), getConnectorProvider: (...args: unknown[]) => provider(...args),
}));
jest.mock('../provider-binding', () => ({ readProviderBinding: (...args: unknown[]) => binding(...args) }));
jest.mock('../composio-transport', () => ({ createComposioClient: () => ({ request: jest.fn() }) }));
jest.mock('../composio-accounts', () => ({ getAccount: (...args: unknown[]) => account(...args), listAccounts: (...args: unknown[]) => accounts(...args), revokeAccount: (...args: unknown[]) => revoke(...args) }));

const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const key = randomBytes(32).toString('hex');
const initial = {
  id, site_id: site, revision: 1, provider_id: 'provider', provider_project_id: 'project', toolkit_slug: 'gmail',
  provider_account_id: 'account', auth_config_id: 'config', provider_status: 'ACTIVE', enabled: true,
  revocation_pending: false, revocation_dispatched: false, display_name: 'Sales email', verified_at: '2026-11-01T00:00:00Z', granted_scopes: ['read'], created_by: user,
};
let state: Omit<typeof initial, 'verified_at'> & { verified_at: string | null };
function query(data: unknown, error: unknown = null, count = Array.isArray(data) ? data.length : null) {
  const result: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error, count }).then(resolve) };
  for (const key of ['select', 'eq', 'in', 'limit', 'abortSignal']) result[key] = jest.fn(() => result);
  return result;
}
beforeEach(() => {
  jest.clearAllMocks(); state = { ...initial };
  access.mockResolvedValue({ can_view: true, can_manage: true });
  visible.mockImplementation(async () => ({ ...state }));
  visibleList.mockImplementation(async () => [{ ...state }]);
  credential.mockResolvedValue({ apiKey: key, revision: 'credential-revision' });
  provider.mockResolvedValue({ id: 'provider', site_id: site, project_id: 'project', provider_user_id: site, status: 'active', credential_revision: 'credential-revision' });
  binding.mockReturnValue({ projectId: 'project' });
  account.mockResolvedValue({ id: 'account', userId: site, toolkitSlug: 'gmail', authConfigId: 'config', status: 'ACTIVE', scopes: ['new-read'], authConfigDisabled: false });
  accounts.mockResolvedValue({ items: [], next_cursor: null });
  revoke.mockResolvedValue({ id: 'account', status: 'REVOKED' });
  from.mockImplementation(() => query([]));
  rpc.mockImplementation((_name, args) => {
    if (_name === 'connector_claim_revocation') {
      state = { ...state, revision: args.p_expected_revision + 1, revocation_dispatched: true };
      return query({ ...state });
    }
    state = { ...state, revision: args.p_expected_revision + 1, enabled: state.enabled && !args.p_revocation_pending && args.p_provider_status === 'ACTIVE' && args.p_verified,
      provider_status: args.p_provider_status, revocation_pending: args.p_revocation_pending, granted_scopes: args.p_granted_scopes,
      verified_at: args.p_verified ? '2026-11-19T00:00:00Z' : null };
    return query({ ...state });
  });
});

it('visible connection DTOs exclude provider references, credentials and implicit manager use', async () => {
  const result = await listConnections(site, user);
  expect(result.items[0]).toMatchObject({ id, can_use: false });
  expect(result.items[0]).not.toHaveProperty('provider_account_id');
  expect(result.items[0]).not.toHaveProperty('auth_config_id');
  expect(result.items[0]).not.toHaveProperty('provider_project_id');
  expect(JSON.stringify(result)).not.toContain(key);
  expect(account).not.toHaveBeenCalled();
});

it('synchronizes only the exact existing account and refreshes scopes with actor/CAS', async () => {
  const result = await syncConnector(site, user, id, 1);
  expect(result.revision).toBe(2);
  expect(account).toHaveBeenCalledWith(expect.anything(), 'account');
  expect(rpc).toHaveBeenCalledWith('connector_set_provider_state', expect.objectContaining({ p_site_id: site, p_connector_id: id, p_actor_id: user, p_expected_revision: 1, p_granted_scopes: ['new-read'], p_credential_revision: 'credential-revision' }));
  expect(accounts).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
});

it('inactive accounts disable execution, while ACTIVE sync never reenables a disabled connector', async () => {
  account.mockResolvedValueOnce({ id: 'account', userId: site, toolkitSlug: 'gmail', authConfigId: 'config', status: 'EXPIRED', scopes: ['read'] });
  const inactive = await syncConnector(site, user, id, 1);
  expect(inactive.connection.enabled).toBe(false); expect(state.granted_scopes).toEqual([]);
  const active = await syncConnector(site, user, id, 2);
  expect(active.connection.provider_status).toBe('ACTIVE'); expect(active.connection.enabled).toBe(false);
});

it('partial pages and missing owner proof cannot mark absent accounts revoked or auto-adopt another', async () => {
  account.mockResolvedValueOnce({ id: 'account', toolkitSlug: 'gmail', authConfigId: 'config', status: 'ACTIVE', scopes: [] });
  accounts.mockResolvedValue({ items: [{ id: 'unrelated' }], next_cursor: 'more' });
  await expect(syncConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'SYNC_INCOMPLETE' });
  expect(rpc).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  expect(state.provider_status).toBe('ACTIVE');
});

it.each([{ userId: 'foreign' }, { toolkitSlug: 'hubspot' }, { authConfigId: 'foreign' }, { accountType: 'SHARED' }])('rejects foreign identity %p before mutation', async mismatch => {
  account.mockResolvedValueOnce({ id: 'account', userId: site, toolkitSlug: 'gmail', authConfigId: 'config', status: 'ACTIVE', scopes: [], ...mismatch });
  await expect(syncConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'CONNECTOR_ACCOUNT_MISMATCH' });
  expect(rpc).not.toHaveBeenCalled();
});

it('fails closed for stale revision, cross-site visibility, binding changes and provider outages', async () => {
  await expect(syncConnector(site, user, id, 9)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND', 'Not found.', 404));
  await expect(syncConnector(site, user, id, 1)).rejects.toMatchObject({ status: 404 });
  binding.mockReturnValueOnce({ projectId: 'foreign-project' });
  await expect(syncConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'PROVIDER_REVALIDATION_REQUIRED' });
  account.mockRejectedValueOnce(new ConnectorError('PROVIDER_UNAVAILABLE', 'Unavailable.', 503));
  await expect(syncConnector(site, user, id, 1)).rejects.toMatchObject({ status: 503 });
  expect(rpc).not.toHaveBeenCalled();
});

it('disables locally before provider work then confirms revocation with second CAS', async () => {
  revoke.mockImplementationOnce(async () => {
    expect(state.enabled).toBe(false); expect(state.revocation_pending).toBe(true); expect(state.revision).toBe(3);
    return { id: 'account', status: 'REVOKED' };
  });
  const result = await disconnectConnector(site, user, id, 1);
  expect(result.revision).toBe(4); expect(result.connection.provider_status).toBe('REVOKED');
  expect(result.connection.revocation_pending).toBe(false); expect(result.connection.enabled).toBe(false);
  expect(rpc).toHaveBeenNthCalledWith(1, 'connector_set_provider_state', expect.objectContaining({ p_expected_revision: 1, p_revocation_pending: true, p_verified: false }));
  expect(rpc).toHaveBeenNthCalledWith(2, 'connector_claim_revocation', expect.objectContaining({ p_expected_revision: 2 }));
  expect(rpc).toHaveBeenNthCalledWith(3, 'connector_set_provider_state', expect.objectContaining({ p_expected_revision: 3, p_provider_status: 'REVOKED', p_revocation_pending: false }));
});

it('missing credentials and unknown provider outcome retain disabled pending state without automatic retry', async () => {
  credential.mockRejectedValueOnce(new ConnectorError('NOT_CONFIGURED', 'Missing.', 422));
  await expect(disconnectConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  expect(state).toMatchObject({ enabled: false, revocation_pending: true }); expect(revoke).not.toHaveBeenCalled();
  state = { ...initial }; rpc.mockClear();
  revoke.mockRejectedValueOnce(new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'Reconcile.', 502));
  await expect(disconnectConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
  expect(state).toMatchObject({ enabled: false, revocation_pending: true });
  await expect(disconnectConnector(site, user, id, 3)).rejects.toMatchObject({ code: 'REVOCATION_RECONCILIATION_REQUIRED' });
  expect(revoke).toHaveBeenCalledTimes(1);
});

it('allows explicit first dispatch after a preflight failure without reenabling the account', async () => {
  credential.mockRejectedValueOnce(new ConnectorError('NOT_CONFIGURED', 'Missing.', 422));
  await expect(disconnectConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  expect(state).toMatchObject({ enabled: false, revocation_pending: true, revocation_dispatched: false, revision: 2 });
  const result = await disconnectConnector(site, user, id, 2);
  expect(result.connection.provider_status).toBe('REVOKED');
  expect(result.connection.enabled).toBe(false);
  expect(revoke).toHaveBeenCalledTimes(1);
});

it('rechecks authority, revision and credentials immediately before external revoke', async () => {
  account.mockImplementationOnce(async () => {
    access.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Removed.', 403));
    return { id: 'account', userId: site, toolkitSlug: 'gmail', authConfigId: 'config', status: 'ACTIVE', scopes: [] };
  });
  await expect(disconnectConnector(site, user, id, 1)).rejects.toMatchObject({ status: 403 });
  expect(revoke).not.toHaveBeenCalled(); expect(state.enabled).toBe(false);
});

it.each(['revision', 'credential'])('does not revoke when %s changes during provider verification', async change => {
  account.mockImplementationOnce(async () => {
    if (change === 'revision') state = { ...state, revision: state.revision + 1 };
    else credential.mockResolvedValue({ apiKey: key, revision: 'rotated' });
    return { id: 'account', userId: site, toolkitSlug: 'gmail', authConfigId: 'config', status: 'ACTIVE', scopes: [] };
  });
  await expect(disconnectConnector(site, user, id, 1)).rejects.toMatchObject({ status: 409 });
  expect(revoke).not.toHaveBeenCalled(); expect(state.enabled).toBe(false);
});

it('sync preserves pending revocation unless the exact owned account is confirmed revoked', async () => {
  state = { ...state, revocation_pending: true, enabled: false };
  const pending = await syncConnector(site, user, id, 1);
  expect(pending.connection.revocation_pending).toBe(true); expect(pending.connection.enabled).toBe(false);
  account.mockResolvedValueOnce({ id: 'account', userId: site, toolkitSlug: 'gmail', authConfigId: 'config', status: 'REVOKED', scopes: [] });
  const confirmed = await syncConnector(site, user, id, 2);
  expect(confirmed.connection.revocation_pending).toBe(false); expect(confirmed.connection.enabled).toBe(false);
  expect(revoke).not.toHaveBeenCalled();
});

it('a lost local post-revoke receipt is unknown, never a false success', async () => {
  revoke.mockImplementationOnce(async () => {
    rpc.mockImplementationOnce(() => query(null, { code: '40001' }));
    return { id: 'account', status: 'REVOKED' };
  });
  await expect(disconnectConnector(site, user, id, 1)).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN', status: 502 });
  expect(state).toMatchObject({ enabled: false, revocation_pending: true }); expect(revoke).toHaveBeenCalledTimes(1);
});
it('exposes workspace inheritance and legacy explicit mode in summaries', async () => {
  const inherited = { ...initial, access_mode: 'workspace' };
  visibleList.mockResolvedValue([inherited]);
  access.mockResolvedValue({ can_view: true, can_manage: false });
  expect(await listConnections(site, user)).toMatchObject({ items: [{ access_mode: 'workspace', can_use: true }] });
  const viewOnly = { connector_id: id, user_id: user, can_view: true, can_use: false, expires_at: null };
  from.mockReturnValueOnce(query([viewOnly]));
  expect(await listConnections(site, user)).toMatchObject({ items: [{ access_mode: 'workspace', can_use: false }] });
  from.mockReturnValueOnce(query([{ ...viewOnly, expires_at: '2000-01-01T00:00:00Z' }]));
  expect(await listConnections(site, user)).toMatchObject({ items: [] });
  visibleList.mockResolvedValue([initial]);
  expect(await listConnections(site, user)).toMatchObject({ items: [] });
});

it('fails closed when the grant query omits a counted row', async () => {
  visibleList.mockResolvedValue([{ ...initial, access_mode: 'workspace' }]);
  from.mockReturnValueOnce(query([], null, 1));
  await expect(listConnections(site, user)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});


it('reads a single actor-visible account projection without provider calls, list fallback or credential access', async () => {
  const dto = await getConnectionSummary(site, user, id);
  expect(visible).toHaveBeenCalledWith(site, user, id);
  expect(dto).toMatchObject({ id, display_name: initial.display_name, can_use: false });
  expect(dto).not.toHaveProperty('provider_account_id');
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND', 'Unavailable.', 404));
  await expect(getConnectionSummary(site, user, id)).rejects.toMatchObject({ status: 404 });
  expect(visibleList).not.toHaveBeenCalled(); expect(credential).not.toHaveBeenCalled(); expect(account).not.toHaveBeenCalled();
});
