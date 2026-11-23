import { randomBytes } from 'node:crypto';
import { connectSupabaseToken } from '../supabase-token';
import { ConnectorError } from '../types';

const prepare = jest.fn(); const request = jest.fn(); const ensure = jest.fn();
const verify = jest.fn(); const insert = jest.fn(); const update = jest.fn(); const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  from: () => ({ insert: (...args: unknown[]) => insert(...args), update: (...args: unknown[]) => update(...args) }),
  rpc: (...args: unknown[]) => rpc(...args),
} }));
jest.mock('../access', () => ({ requireConnectorSiteAccess: jest.fn(), loadConnectorCredential: async () => ({ revision: 'revision' }) }));
jest.mock('../provider-binding', () => ({ readTokenProviderBinding: async () => ({ projectId: 'project' }), prepareConnectorTokenProvider: (...args: unknown[]) => prepare(...args) }));
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'), createComposioClient: () => ({ request }) }));
jest.mock('../managed-oauth', () => ({ ensureSupabaseTokenConfig: (...args: unknown[]) => ensure(...args) }));
jest.mock('../composio-accounts', () => ({ verifyAccountIdentity: (...args: unknown[]) => verify(...args) }));

const site = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';
const input = { site_id: site, project_ref: 'a'.repeat(20), token: `sbp_${randomBytes(24).toString('hex')}` };
const fetchMock = jest.fn();
const previousFetch = global.fetch;

function result(id: string) {
  const promise = Promise.resolve({ data: { id }, error: null });
  const chain = { then: promise.then.bind(promise) };
  return Object.assign(chain, { select: () => chain, abortSignal: () => chain, single: () => chain, eq: () => chain });
}

beforeEach(() => {
  jest.resetAllMocks(); global.fetch = fetchMock;
  fetchMock.mockResolvedValue(new Response('{}'));
  prepare.mockResolvedValue({ provider: { id: 'provider', project_id: 'project', provider_user_id: site }, credential: { revision: 'revision' } });
  ensure.mockResolvedValue('ac_supabase');
  insert.mockReturnValue(result(attempt)); update.mockReturnValue(result(attempt)); rpc.mockReturnValue(result(site));
  request.mockResolvedValue({ id: 'ca_supabase', token: input.token });
});
afterAll(() => { global.fetch = previousFetch; });

it('checks project access and only finalizes the exact active account without recording the token', async () => {
  expect(await connectSupabaseToken(input, actor)).toEqual({ status: 'completed', connector_id: site });
  expect(fetchMock).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${input.project_ref}`, expect.objectContaining({ redirect: 'error', headers: { Authorization: `Bearer ${input.token}` } }));
  expect(request).toHaveBeenCalledWith('/connected_accounts', expect.objectContaining({ body: expect.objectContaining({ connection: expect.objectContaining({ user_id: site, state: { authScheme: 'API_KEY', val: { status: 'ACTIVE', full: 'https://api.supabase.com', bearer_token: input.token } } }) }) }));
  expect(verify).toHaveBeenCalledWith(expect.anything(), { authConfigId: 'ac_supabase', accountId: 'ca_supabase', toolkitSlug: 'supabase', userId: site });
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ supabase_project_ref: input.project_ref }));
  expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
  expect(JSON.stringify([insert.mock.calls, update.mock.calls, rpc.mock.calls])).not.toContain(input.token);
});

it('does not send an unauthorized actor’s token to any provider', async () => {
  prepare.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  await expect(connectSupabaseToken(input, actor)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(fetchMock).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

it('rejects an unusable token before creating any provider resource', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
  await expect(connectSupabaseToken(input, actor)).rejects.toMatchObject({ code: 'SUPABASE_TOKEN_REJECTED' });
  expect(ensure).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});

it('records an unconfirmed account without finalizing or retrying a remote write', async () => {
  verify.mockRejectedValue(new ConnectorError('CONNECTOR_NOT_ACTIVE', 'Not active.', 409));
  await expect(connectSupabaseToken(input, actor)).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
  expect(update).toHaveBeenCalledWith({ status: 'outcome_unknown' });
  expect(request).toHaveBeenCalledTimes(1); expect(rpc).not.toHaveBeenCalled();
});
it('only delegates the exact private native API key on the disclosed customer-key submission', async()=>{
  verify.mockResolvedValue({accountType:'PRIVATE',apiKeyAuth:true,hostedSupabasePat:true});
  await connectSupabaseToken({...input,delegate_account:true},actor);
  expect(rpc).toHaveBeenCalledWith('connector_finalize_customer_account',expect.objectContaining({p_attempt_id:attempt,p_actor_id:actor,p_provider_account_id:'ca_supabase',p_auth_scheme:'API_KEY'}));
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(input.token);
  rpc.mockClear();verify.mockResolvedValue({accountType:'SHARED',apiKeyAuth:true,hostedSupabasePat:true});
  await expect(connectSupabaseToken({...input,delegate_account:true},actor)).rejects.toBeInstanceOf(ConnectorError);
  expect(rpc).not.toHaveBeenCalled();
});
