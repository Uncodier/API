import { createHash, createHmac, randomBytes } from 'node:crypto';
import { finishConnectorAuth, startConnectorAuth } from '../auth-attempts';
import { connectionSetup, existingSetupKey } from '../connection-onboarding';
import type { ComposioToolkit, ComposioAuthConfig } from '../composio-catalog';
import { ConnectorError } from '../types';
import { attestedProject, byokRpc, byokOrigin } from './byok-rpc-fixture';

const rpc = jest.fn();
const proofRpc = jest.fn();
const from = jest.fn();
const insert = jest.fn();
const complete = jest.fn();
const verify = jest.fn();
const toolkit = jest.fn();
let mockConfigScheme='OAUTH2';
const configs = jest.fn();
const link = jest.fn();
const request = jest.fn();
const lock = jest.fn();
const release = jest.fn();
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
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'), createComposioClient: () => ({ request }) }));
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: (...args: unknown[]) => lock(...args), releaseLock: (...args: unknown[]) => release(...args) }));
jest.mock('../composio-accounts', () => ({ createAuthLink: (...args: unknown[]) => link(...args), completeAuth: (...args: unknown[]) => complete(...args), verifyAccountIdentity: (...args: unknown[]) => verify(...args) }));
jest.mock('../composio-catalog', () => ({ getToolkit: (...args: unknown[]) => toolkit(...args), listAuthConfigs: (...args: unknown[]) => configs(...args) }));

const siteId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const nonce = randomBytes(32).toString('hex');
const revision = randomBytes(32).toString('hex');
const continuation = createHmac('sha256', nonce).update(`connector-tab:v1:${attemptId}`).digest('hex');
const input = { siteId, userId, attemptId, nonce, continuation, sessionUri: 'opaque-provider-proof' };
let attempt: Record<string, unknown>;
let overlapping: Array<Record<string, unknown>> = [];
let claimSucceeds = true;
let updates: Array<Record<string, unknown>>;

function result(data: unknown, error: unknown = null) {
  const chain: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve) };
  for (const method of ['select', 'eq', 'neq', 'gte', 'gt', 'maybeSingle', 'single', 'abortSignal']) chain[method] = () => chain;
  const conditions: Array<(row: Record<string, unknown>) => boolean> = [];
  chain.eq = (key: string, value: unknown) => { conditions.push(row => row[key] === value); return chain; };
  chain.neq = (key: string, value: unknown) => { conditions.push(row => row[key] !== value); return chain; };
  chain.gte = (key: string, value: string) => { conditions.push(row => String(row[key]) >= value); return chain; };
  chain.limit = (n: number) => result(overlapping.filter(row => conditions.every(check => check(row))).slice(0, n));
  chain.update = (patch: Record<string, unknown>) => { updates.push(patch); return result(claimSucceeds ? { id: attemptId } : null); };
  chain.insert = (row:Record<string,unknown>) => { insert(row); return result({ id: attemptId, expires_at: new Date(Date.now() + 60_000).toISOString() }); };
  return chain;
}

const oldOrigin = process.env.CONNECTORS_WEB_ORIGIN;
beforeAll(() => { process.env.CONNECTORS_WEB_ORIGIN = byokOrigin; });
afterAll(() => { if (oldOrigin === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = oldOrigin; });
beforeEach(() => {
  proofRpc.mockReset().mockImplementation(attestedProject({site_id: siteId, project_id: 'proj_test', credential_revision: revision}));
  jest.clearAllMocks(); mockConfigScheme='OAUTH2'; updates = []; overlapping = []; claimSucceeds = true;
  attempt = { id: attemptId, site_id: siteId, provider_id: siteId, user_id: userId,
    toolkit_slug: 'gmail', auth_config_id: 'ac_test', provider_account_id: 'ca_test',
    nonce_hash: createHash('sha256').update(nonce).digest('hex'), credential_revision: revision,
    status: 'pending', setup_mode: 'legacy', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), connector_id: null };
  from.mockImplementation(() => result(attempt));
  const providerValue = { id: siteId, provider_user_id: siteId, project_id: 'proj_test', credential_revision: revision, status: 'active' };
  provider.mockResolvedValue(providerValue);
  credential.mockResolvedValue({ apiKey: randomBytes(20).toString('hex'), revision });
  prepare.mockResolvedValue({ provider: providerValue, credential: { apiKey: randomBytes(20).toString('hex'), revision }, callbackUrl: `${byokOrigin}/connectors/callback` });
  complete.mockResolvedValue({ accountId: 'ca_test', toolkitSlug: 'gmail' });
  verify.mockResolvedValue({ id: 'ca_test', toolkitSlug: 'gmail', authConfigId: 'ac_test', status: 'ACTIVE', scopes: [], name: 'Gmail' });
  rpc.mockImplementation(() => result({ id: siteId }));
  link.mockResolvedValue({ accountId: 'ca_test', redirectUrl: 'https://connect.composio.dev/link', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  configs.mockReset().mockImplementation(async (_client, slug) => ({ items: [{ id: 'ac_test', toolkitSlug: slug, authScheme: mockConfigScheme, status: 'ENABLED' }] }));
  lock.mockResolvedValue({ state: 'acquired', token: 'lock-owner' });
});

it.each([undefined,true] as const)('persists the onboarding intent only for the disclosed start (%s), before requesting OAuth', async askOnConnect => {
  const value = await startConnectorAuth({ siteId, userId, toolkitSlug: 'gmail', authConfigId: 'ac_test', nonce, askOnConnect });
  expect(value).toEqual({ attempt_id: attemptId, redirect_url: 'https://connect.composio.dev/link' });
  expect(from.mock.invocationCallOrder[0]).toBeLessThan(link.mock.invocationCallOrder[0]);
  expect(insert).toHaveBeenCalledTimes(1);
  if (askOnConnect) expect(insert.mock.calls[0][0]).toMatchObject({ask_on_connect:true,user_id:userId,site_id:siteId});
  else expect(insert.mock.calls[0][0]).not.toHaveProperty('ask_on_connect');
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


it('delegates private native OAuth on any toolkit using the exact notice-bearing completed attempt', async () => {
  const slug='newprovider',checked={id:'ca_test',toolkitSlug:slug,authConfigId:'ac_test',accountType:'PRIVATE',oauth2:true,scopes:[]};
  attempt.toolkit_slug=slug;complete.mockResolvedValue({accountId:'ca_test',toolkitSlug:slug});
  const native={type:'native',toolkit_type:'api',enabled:true};
  for (const [notice,a,t,delegated] of [
    [true,checked,native,true],[false,checked,native,false],
    ...[{accountType:undefined},{accountType:'SHARED'},{oauth2:false}].map(patch=>[true,{...checked,...patch},native,false]),
    ...[{type:'custom'},{enabled:false},{toolkit_type:'mcp'}].map(patch=>[true,checked,{...native,...patch},false]),
  ]) {
    attempt.ask_on_connect=notice;rpc.mockClear();verify.mockResolvedValue(a);toolkit.mockResolvedValue(t);
    await finishConnectorAuth(input);
    expect(rpc).toHaveBeenCalledWith(delegated?'connector_finalize_customer_account':'connector_finalize_auth',expect.objectContaining({p_attempt_id:attemptId,p_actor_id:userId,...(delegated?{p_auth_scheme:'OAUTH2'}:{})}));
  }
});

it('delegates an API key entered on the provider hosted link, never requiring the key in the callback body',async()=>{
  mockConfigScheme='API_KEY';const slug='examplecrm';
  await expect(startConnectorAuth({siteId,userId,nonce,toolkitSlug:slug,authConfigId:'ac_test',askOnConnect:true})).resolves.toMatchObject({attempt_id:attemptId});
  attempt.toolkit_slug=slug;attempt.ask_on_connect=true;
  complete.mockResolvedValue({accountId:'ca_test',toolkitSlug:slug});
  verify.mockResolvedValue({id:'ca_test',authConfigId:'ac_test',toolkitSlug:slug,accountType:'PRIVATE',oauth2:false,apiKeyAuth:true,scopes:[]});
  toolkit.mockResolvedValue({type:'native',toolkit_type:'api',enabled:true});
  await finishConnectorAuth(input);
  expect(rpc).toHaveBeenCalledWith('connector_finalize_customer_account',expect.objectContaining({p_auth_scheme:'API_KEY',p_provider_account_id:'ca_test',p_attempt_id:attemptId}));
});

function existingSelection() {
  return { authConfigId: 'ac_test', expectedSetup: existingSetupKey(revision, { slug: 'gmail' } as ComposioToolkit,
    { id: 'ac_test', authScheme: mockConfigScheme } as ComposioAuthConfig) };
}

it.each(['OAUTH2','OAUTH1','DCR_OAUTH'])('starts and completes the exact private %s account without delegating Ask', async scheme => {
  mockConfigScheme = scheme;
  toolkit.mockResolvedValue({ slug: 'gmail', type: 'native', enabled: true, auth_schemes: [scheme] });
  await expect(startConnectorAuth({ siteId, userId, toolkitSlug: 'gmail', nonce, hosted: true, ...existingSelection() })).resolves.toMatchObject({ attempt_id: attemptId });
  expect(insert.mock.calls[0][0]).toMatchObject({ setup_mode: 'hosted', auth_config_id: 'ac_test', user_id: userId, site_id: siteId });
  expect(insert.mock.calls[0][0]).not.toHaveProperty('ask_on_connect');
  expect(insert.mock.invocationCallOrder[0]).toBeLessThan(link.mock.invocationCallOrder[0]);
  expect(link).toHaveBeenCalledWith(expect.anything(), { authConfigId: 'ac_test', userId: siteId,
    callbackUrl: `${byokOrigin}/connectors/callback`, privateAccount: true });
  attempt.setup_mode = 'hosted';
  verify.mockResolvedValueOnce({ id: 'ca_test', toolkitSlug: 'gmail', authConfigId: 'ac_test', authScheme: scheme, accountType: 'PRIVATE', scopes: [] });
  await expect(finishConnectorAuth(input)).resolves.toMatchObject({ status: 'completed' });
  expect(rpc).toHaveBeenCalledWith('connector_finalize_auth', expect.objectContaining({ p_provider_account_id: 'ca_test', p_attempt_id: attemptId }));
  expect(rpc).toHaveBeenCalledTimes(1);
});

const credentialCompletion = { siteId, userId, attemptId, nonce, hostedCredential: true as const };
function useBasicCredential() {
  mockConfigScheme = 'BASIC';
  toolkit.mockResolvedValue({ slug: 'gmail', type: 'native', enabled: true, auth_schemes: ['BASIC'], account_credential_schemes: ['BASIC'] });
  attempt.setup_mode = 'hosted_credentials';
  verify.mockResolvedValue({ id: 'ca_test', toolkitSlug: 'gmail', authConfigId: 'ac_test', status: 'ACTIVE', authScheme: 'BASIC', accountType: 'PRIVATE', scopes: [] });
}

it('binds a credential callback to its attempt and verifies the stored account without redeeming OAuth proof', async () => {
  useBasicCredential();
  await startConnectorAuth({ siteId, userId, toolkitSlug: 'gmail', nonce, hosted: true, ...existingSelection() });
  expect(insert.mock.calls[0][0]).toMatchObject({ setup_mode: 'hosted_credentials' });
  expect(link).toHaveBeenCalledWith(expect.anything(), { authConfigId: 'ac_test', userId: siteId,
    callbackUrl: `${byokOrigin}/connectors/callback?credential_attempt=${attemptId}`, privateAccount: true });
  await expect(finishConnectorAuth(credentialCompletion)).resolves.toMatchObject({ status: 'completed' });
  expect(complete).not.toHaveBeenCalled();
  expect(verify).toHaveBeenCalledWith(expect.anything(), { accountId: 'ca_test', userId: siteId, toolkitSlug: 'gmail', authConfigId: 'ac_test' });
  expect(rpc).toHaveBeenCalledWith('connector_finalize_auth', expect.objectContaining({ p_provider_account_id: 'ca_test', p_attempt_id: attemptId }));
});

it.each(['legacy', 'hosted', undefined])('does not let a credential callback redeem a %s OAuth attempt', async mode => {
  attempt.setup_mode = mode;
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(verify).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it('never claims a credential attempt while its account is inactive, changed or unverified', async () => {
  useBasicCredential();
  verify.mockRejectedValueOnce(new ConnectorError('CONNECTOR_NOT_ACTIVE', 'Pending.', 409));
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code: 'CONNECTOR_NOT_ACTIVE' });
  verify.mockResolvedValueOnce({ authScheme: 'OAUTH2', accountType: 'PRIVATE' });
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code: 'CONNECTOR_ACCOUNT_MISMATCH' });
  verify.mockResolvedValueOnce({ authScheme: 'BASIC' });
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code: 'CONNECTOR_ACCOUNT_MISMATCH' });
  configs.mockResolvedValueOnce({ items: [] });
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code: 'AUTH_CONFIG_UNAVAILABLE' });
  expect(updates).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
});

it('refuses to start the hosted redirect when the bound credential changes', async () => {
  toolkit.mockResolvedValueOnce({ slug: 'gmail', type: 'native', enabled: true, auth_schemes: ['OAUTH2'] });
  credential.mockResolvedValueOnce({ revision: 'rotated' });
  await expect(startConnectorAuth({ siteId, userId, toolkitSlug: 'gmail', nonce, hosted: true, ...existingSelection() })).rejects.toMatchObject({ code: 'PROVIDER_REVALIDATION_REQUIRED' });
  expect(insert).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
});

it('starts the first Meta Ads sign-in in one request, with a newly provisioned and verified config', async () => {
  const slug = 'metaads';
  const meta = { slug, type: 'native', enabled: true, auth_schemes: ['OAUTH2', 'API_KEY'],
    default_managed_auth: { scheme: 'OAUTH2', appId: 'app_meta' }, empty_config_schemes: ['API_KEY'] } as ComposioToolkit;
  toolkit.mockResolvedValue(meta);
  const config = { id: 'ac_meta', toolkitSlug: slug, authScheme: 'OAUTH2', status: 'ENABLED', isManaged: true, managedAppId: 'app_meta' };
  configs.mockReset().mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [config] });
  request.mockResolvedValueOnce({ toolkit: { slug }, auth_config: { id: config.id, auth_scheme: 'OAUTH2', is_composio_managed: true, managed_app_id: 'app_meta' } });
  await expect(startConnectorAuth({ siteId, userId, toolkitSlug: slug, nonce, hosted: true, expectedSetup: connectionSetup(meta, [], revision).setup_key! }))
    .resolves.toEqual({ attempt_id: attemptId, redirect_url: 'https://connect.composio.dev/link' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(insert.mock.calls[0][0]).toMatchObject({ toolkit_slug: slug, auth_config_id: config.id, setup_mode: 'hosted' });
  expect(configs.mock.invocationCallOrder[2]).toBeLessThan(link.mock.invocationCallOrder[0]);
  expect(link).toHaveBeenCalledWith(expect.anything(), { authConfigId: config.id, userId: siteId,
    callbackUrl: `${byokOrigin}/connectors/callback`, privateAccount: true });
});


it('refuses the wrong tab tag and overlapping OAuth attempts before claiming or spending proof', async () => {
  await expect(finishConnectorAuth({ ...input, continuation: randomBytes(32).toString('hex') })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  overlapping = [{ ...attempt, id: userId, user_id: siteId, status: 'outcome_unknown' }];
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_AMBIGUOUS' });
  expect(updates).toEqual([]); expect(complete).not.toHaveBeenCalled();
});

it('never spends an OAuth proof on a credential attempt', async () => {
  useBasicCredential();
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(updates).toEqual([]); expect(complete).not.toHaveBeenCalled();
});

it.each(['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'STORAGE_UNAVAILABLE'])('marks a credential read %s safely retryable only before the claim', async code => {
  useBasicCredential();
  verify.mockRejectedValueOnce(new ConnectorError(code, 'Read unavailable.', 503));
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code: 'CREDENTIAL_CHECK_UNAVAILABLE' });
  expect(updates).toEqual([]);
  rpc.mockImplementationOnce(() => { throw new ConnectorError(code, 'Finalization uncertain.', 503); });
  await expect(finishConnectorAuth(credentialCompletion)).rejects.toMatchObject({ code });
  expect(updates).toContainEqual({ status: 'outcome_unknown' });
});

it.each([{ authScheme: 'OAUTH2' }, { authScheme: 'OAUTH2', accountType: 'SHARED' }, { accountType: 'PRIVATE', authScheme: 'OAUTH1' }])('requires positive exact private OAuth evidence for neutral hosted completion (%j)', async account => {
  attempt.setup_mode = 'hosted'; verify.mockResolvedValue(account);
  toolkit.mockResolvedValue({ slug: 'gmail', type: 'native', enabled: true, auth_schemes: ['OAUTH2'] });
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'CONNECTOR_ACCOUNT_MISMATCH' });
  expect(rpc).not.toHaveBeenCalled();
});


it('retains ambiguity even if the other attempt just expired, but a new non-overlapping attempt is safe', async () => {
  const earlier = new Date(Date.now() - 30_000).toISOString();
  overlapping = [{ ...attempt, id: userId, user_id: siteId, expires_at: earlier, status: 'expired' }];
  attempt.created_at = new Date(Date.now() - 60_000).toISOString();
  await expect(finishConnectorAuth(input)).rejects.toMatchObject({ code: 'AUTH_ATTEMPT_AMBIGUOUS' });
  expect(complete).not.toHaveBeenCalled(); expect(updates).toEqual([]);
  attempt.created_at = new Date().toISOString();
  await expect(finishConnectorAuth(input)).resolves.toMatchObject({ status: 'completed' });
  expect(complete).toHaveBeenCalledTimes(1);
});
