import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { prepareConnectorProvider, connectorCallbackUrl, readProviderBinding, readTokenProviderBinding } from '../provider-binding';
import { attestedProject, byokOrigin, byokRpc } from './byok-rpc-fixture';

const mockRpc = jest.fn(), mockFrom = jest.fn();
const manager = jest.fn(), credential = jest.fn(), provider = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args), rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock('../access', () => ({ requireConnectorSiteAccess: (...args:unknown[]) => manager(...args),
  loadConnectorCredential: (...args:unknown[]) => credential(...args), getConnectorProvider: (...args:unknown[]) => provider(...args) }));
const site = randomUUID(); const revision = randomBytes(32).toString('hex');
const row = {site_id: site, project_id: 'reviewed_project', credential_revision: revision};
const callbackUrl = `${byokOrigin}/connectors/callback`;
const original = {...process.env};
beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockReset().mockImplementation(attestedProject(row));
  process.env.CONNECTORS_WEB_ORIGIN = byokOrigin;
});
afterEach(() => { process.env = {...original}; });

it.each([readProviderBinding, readTokenProviderBinding])('requires the exact site, ciphertext revision and verifier URL', async resolve => {
  await expect(resolve(site, revision)).resolves.toEqual({projectId: row.project_id, callbackUrl});
  expect(mockRpc.mock.calls).toEqual([[byokRpc, {p_site_id: site, p_credential_revision: revision, p_oauth_verifier_url: callbackUrl}]]);
  await expect(resolve(randomUUID(), revision)).rejects.toMatchObject({code: 'PROVIDER_SETUP_REQUIRED'});
  await expect(resolve(site, randomBytes(32).toString('hex'))).rejects.toMatchObject({code: 'PROVIDER_SETUP_REQUIRED'});
  process.env.CONNECTORS_WEB_ORIGIN = 'https://other.example.test';
  await expect(resolve(site, revision)).rejects.toMatchObject({code: 'PROVIDER_SETUP_REQUIRED'});
});

it('observes deletion on the next operation; an old deployment list never substitutes for a revoked row', async () => {
  process.env.CONNECTOR_PROVIDER_BINDINGS = JSON.stringify([{...row, oauth_verifier_url:callbackUrl}]);
  await expect(readProviderBinding(site, revision)).resolves.toMatchObject({projectId:row.project_id});
  mockRpc.mockReturnValue({abortSignal: async () => ({data: null, error: null})});
  await expect(readProviderBinding(site, revision)).rejects.toMatchObject({code:'PROVIDER_SETUP_REQUIRED'});
});

it('withholds malformed results and raw storage failures, and never retries or uses another project', async () => {
  const marker = randomBytes(32).toString('hex');
  for (const response of [null, {}, {data:'no/error'}, {data:[row], error:null}, {data:'unexpected/path', error:null},
    {data:'possibly_valid', error:{details:marker}}]) {
    mockRpc.mockReturnValueOnce({abortSignal: async (signal: AbortSignal) => {expect(signal).toBeInstanceOf(AbortSignal); return response;}});
    await expect(readProviderBinding(site, revision)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE',status:503});
  }
  mockRpc.mockImplementationOnce(() => { throw new Error(marker); });
  const error = await readProviderBinding(site, revision).catch(e => e);
  expect(error.code).toBe('STORAGE_UNAVAILABLE'); expect(String(error)).not.toContain(marker);
  expect(mockRpc).toHaveBeenCalledTimes(7);
});

it('never sends an invalid revision or an unsafe callback to the registry', async () => {
  await expect(readProviderBinding(site, 'not-a-revision')).rejects.toMatchObject({code:'PROVIDER_SETUP_REQUIRED'});
  const userinfo = new URL(byokOrigin); userinfo.username = randomBytes(8).toString('hex'); userinfo.password = randomBytes(8).toString('hex');
  for (const origin of ['http://example.invalid', `${byokOrigin}/path`, userinfo.href, `${byokOrigin}?redirect=elsewhere`]) {
    process.env.CONNECTORS_WEB_ORIGIN = origin;
    expect(() => connectorCallbackUrl()).toThrow();
    await expect(readTokenProviderBinding(site, revision)).rejects.toMatchObject({code:'PROVIDER_SETUP_REQUIRED'});
  }
  expect(mockRpc).not.toHaveBeenCalled();
});

it('keeps the platform path deployment-wide, with no registry read and no callback requirement for token setup', async () => {
  const key = randomBytes(32).toString('hex'); process.env.COMPOSIO_API_KEY = key; process.env.COMPOSIO_PROJECT_ID = 'platform_project';
  const rev = `platform:${createHash('sha256').update(key).digest('hex')}`;
  await expect(readProviderBinding(site, rev)).resolves.toEqual({projectId:'platform_project', callbackUrl});
  delete process.env.CONNECTORS_WEB_ORIGIN;
  await expect(readTokenProviderBinding(randomUUID(), rev)).resolves.toEqual({projectId:'platform_project'});
  await expect(readProviderBinding(site, rev)).rejects.toMatchObject({code:'PROVIDER_SETUP_REQUIRED'});
  expect(mockRpc).not.toHaveBeenCalled();
});


it('authorizes before proof lookup and never migrates or re-enables an existing provider row', async () => {
  const actor = randomUUID();
  manager.mockRejectedValueOnce(new Error('Not a manager'));
  await expect(prepareConnectorProvider(site, actor)).rejects.toThrow('Not a manager');
  expect(mockRpc).not.toHaveBeenCalled(); expect(credential).not.toHaveBeenCalled();
  manager.mockResolvedValue({can_manage: true});
  credential.mockResolvedValue({revision, source:'byok', apiKey: randomBytes(32).toString('hex')});
  const current = {...row, provider_user_id:site, status:'active'};
  for (const [patch,code] of [
    [{project_id:'other'},'PROVIDER_PROJECT_CHANGED'],[{provider_user_id: randomUUID()},'PROVIDER_PROJECT_CHANGED'],
    [{status:'disabled'},'PROVIDER_REVALIDATION_REQUIRED'],[{credential_revision:randomBytes(32).toString('hex')},'PROVIDER_REVALIDATION_REQUIRED'],
  ] as const) {
    provider.mockResolvedValueOnce({...current,...patch});
    await expect(prepareConnectorProvider(site, actor)).rejects.toMatchObject({code});
  }
  expect(manager).toHaveBeenCalledWith(site,actor,true); expect(mockFrom).not.toHaveBeenCalled();
});
