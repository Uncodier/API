import { createHash, randomBytes } from 'node:crypto';
import { finishConnectorAuth, startConnectorAuth } from '../auth-attempts';
import { attestedProject, byokRpc, byokOrigin } from './byok-rpc-fixture';

const rpc = jest.fn();
const proofRpc = jest.fn();
const from = jest.fn();
const complete = jest.fn();
const verify = jest.fn();
const link = jest.fn();
const prepare = jest.fn();
const credential = jest.fn();
const provider = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (name: string, ...args: unknown[]) => name === byokRpc ? proofRpc(name, ...args) : rpc(name, ...args), from: (...args: unknown[]) => from(...args) } }));
jest.mock('../access', () => ({
  requireConnectorSiteAccess: jest.fn(),
  loadConnectorCredential: (...args: unknown[]) => credential(...args),
  getConnectorProvider: (...args: unknown[]) => provider(...args),
  connectorDatabaseError: () => { throw new Error('Storage unavailable'); },
}));
jest.mock('../provider-binding', () => ({ ...jest.requireActual('../provider-binding'), prepareConnectorProvider: (...args: unknown[]) => prepare(...args) }));
jest.mock('../composio-transport', () => ({ createComposioClient: () => ({}) }));
jest.mock('../composio-accounts', () => ({ createAuthLink: (...args: unknown[]) => link(...args), completeAuth: (...args: unknown[]) => complete(...args), verifyAccountIdentity: (...args: unknown[]) => verify(...args) }));
jest.mock('../composio-catalog', () => ({ listAuthConfigs: async () => ({ items: [{ id: 'ac_test', authScheme: 'OAUTH2', status: 'ENABLED' }] }) }));

const siteId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const nonce = randomBytes(32).toString('hex');
const revision = randomBytes(32).toString('hex');
const input = { siteId, userId, attemptId, nonce, sessionUri: 'opaque-provider-proof' };
let attempt: Record<string, unknown>;
let claimSucceeds = true;
let updates: Array<Record<string, unknown>>;

function result(data: unknown, error: unknown = null) {
  const chain: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve) };
  for (const method of ['select', 'eq', 'maybeSingle', 'single', 'abortSignal']) chain[method] = () => chain;
  chain.update = (patch: Record<string, unknown>) => { updates.push(patch); return result(claimSucceeds ? { id: attemptId } : null); };
  chain.insert = () => result({ id: attemptId, expires_at: new Date(Date.now() + 60_000).toISOString() });
  return chain;
}

const oldOrigin = process.env.CONNECTORS_WEB_ORIGIN;
beforeAll(() => { process.env.CONNECTORS_WEB_ORIGIN = byokOrigin; });
afterAll(() => { if (oldOrigin === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = oldOrigin; });
beforeEach(() => {
  proofRpc.mockReset().mockImplementation(attestedProject({site_id: siteId, project_id: 'proj_test', credential_revision: revision}));
  jest.clearAllMocks(); updates = []; claimSucceeds = true;
  attempt = { id: attemptId, site_id: siteId, provider_id: siteId, user_id: userId,
    toolkit_slug: 'gmail', auth_config_id: 'ac_test', provider_account_id: 'ca_test',
    nonce_hash: createHash('sha256').update(nonce).digest('hex'), credential_revision: revision,
    status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString(), connector_id: null };
  from.mockImplementation(() => result(attempt));
  const providerValue = { id: siteId, provider_user_id: siteId, project_id: 'proj_test', credential_revision: revision, status: 'active' };
  provider.mockResolvedValue(providerValue);
  credential.mockResolvedValue({ apiKey: randomBytes(20).toString('hex'), revision });
  prepare.mockResolvedValue({ provider: providerValue, credential: { apiKey: randomBytes(20).toString('hex'), revision }, callbackUrl: 'https://app.example.test/connectors/callback' });
  complete.mockResolvedValue({ accountId: 'ca_test', toolkitSlug: 'gmail' });
  verify.mockResolvedValue({ id: 'ca_test', toolkitSlug: 'gmail', authConfigId: 'ac_test', status: 'ACTIVE', scopes: [], name: 'Gmail' });
  rpc.mockImplementation(() => result({ id: siteId }));
  link.mockResolvedValue({ accountId: 'ca_test', redirectUrl: 'https://connect.composio.dev/link', expiresAt: new Date(Date.now() + 60_000).toISOString() });
});

it('persists an attempt before asking the provider for an authorization link', async () => {
  const value = await startConnectorAuth({ siteId, userId, toolkitSlug: 'gmail', authConfigId: 'ac_test', nonce });
  expect(value).toEqual({ attempt_id: attemptId, redirect_url: 'https://connect.composio.dev/link' });
  expect(from.mock.invocationCallOrder[0]).toBeLessThan(link.mock.invocationCallOrder[0]);
  expect(updates).toContainEqual(expect.objectContaining({ provider_account_id: 'ca_test' }));
  expect(JSON.stringify(value)).not.toContain(nonce);
});

it('rejects mismatched browser proof before redeeming provider proof', async () => {
  await expect(finishConnectorAuth({ ...input, nonce: randomBytes(32).toString('hex') })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(complete).not.toHaveBeenCalled();
});

it.each(['completing', 'outcome_unknown', 'expired'])('does not replay single-use proof for %s', async status => {
  attempt.status = status;
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_UNAVAILABLE' });
  expect(complete).not.toHaveBeenCalled();
});

it('requires the exact provider account bound before redirect', async () => {
  complete.mockResolvedValue({ accountId: 'ca_foreign', toolkitSlug: 'gmail' });
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_MISMATCH' });
  expect(verify).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  expect(updates).toContainEqual({ status: 'outcome_unknown' });
});

it('rejects a new callback on a completed attempt without redeeming proof again', async () => {
  attempt.status = 'completed'; attempt.connector_id = siteId;
  await expect(finishConnectorAuth({ ...input, sessionUri: 'unrelated-new-proof' })).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_COMPLETED' });
  expect(complete).not.toHaveBeenCalled();
});

it('only dispatches completion after winning the local claim and checks provider ownership', async () => {
  claimSucceeds = false;
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_BUSY' });
  expect(complete).not.toHaveBeenCalled();
  claimSucceeds = true;
  await expect(finishConnectorAuth(input)).resolves.toMatchObject({ connector_id: siteId });
  expect(verify).toHaveBeenCalledWith(expect.anything(), { accountId: 'ca_test', userId: siteId, toolkitSlug: 'gmail', authConfigId: 'ac_test' });
  expect(rpc).toHaveBeenCalledWith('connector_finalize_auth', expect.objectContaining({ p_actor_id: userId, p_nonce_hash: attempt.nonce_hash }));
});

it.each(['before callback', 'after provider completion'])('does not finalize or replay OAuth after proof withdrawal %s', async stage => {
  const missing = { abortSignal: async () => ({data:null, error:null}) };
  if (stage === 'before callback') proofRpc.mockReturnValue(missing);
  else complete.mockImplementationOnce(async () => {
    proofRpc.mockReturnValue(missing); return { accountId: 'ca_test', toolkitSlug: 'gmail' };
  });
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({code:'PROVIDER_SETUP_REQUIRED'});
  expect(complete).toHaveBeenCalledTimes(stage === 'before callback' ? 0 : 1);
  if (stage === 'before callback') expect(updates).toEqual([]);
  else expect(updates).toContainEqual({status:'outcome_unknown'});
  expect(rpc).not.toHaveBeenCalled();
});
