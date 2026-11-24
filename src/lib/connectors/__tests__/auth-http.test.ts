import { randomBytes } from 'node:crypto';
import { connectorAuthHandler } from '../auth-http';
import { POST as startAsk } from '@/app/api/connectors/auth-attempts/ask/route';
import { POST as startHosted } from '@/app/api/connectors/auth-attempts/hosted/route';
import { ConnectorError } from '../types';

const getUser = jest.fn();
const access = jest.fn();
const start = jest.fn();
const finish = jest.fn();
const read = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: (...args: unknown[]) => getUser(...args) } } }));
jest.mock('../access', () => ({ requireConnectorSiteAccess: (...args: unknown[]) => access(...args) }));
jest.mock('../auth-attempts', () => ({ startConnectorAuth: (...args: unknown[]) => start(...args), finishConnectorAuth: (...args: unknown[]) => finish(...args), getAuthAttempt: (...args: unknown[]) => read(...args) }));

const siteId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const token = randomBytes(32).toString('hex');
const nonce = randomBytes(32).toString('hex');
const originalGate = process.env.CONNECTORS_HOSTED_STARTS_ENABLED;
beforeEach(() => { process.env.CONNECTORS_HOSTED_STARTS_ENABLED = 'true'; });
afterEach(() => {
  if (originalGate === undefined) delete process.env.CONNECTORS_HOSTED_STARTS_ENABLED;
  else process.env.CONNECTORS_HOSTED_STARTS_ENABLED = originalGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  access.mockResolvedValue({ can_view: true, can_manage: true });
  start.mockResolvedValue({ attempt_id: attemptId, redirect_url: 'https://connect.composio.dev/authorize' });
  finish.mockResolvedValue({ connector_id: siteId, toolkit_slug: 'gmail', status: 'completed' });
});

function request(body: unknown, authorization: string | null = `Bearer ${token}`) {
  return new Request('https://api.example.test/api/connectors/auth-attempts', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
  });
}
const body = () => ({ site_id: siteId, toolkit_slug: 'gmail', auth_config_id: 'ac_test', nonce });

it('requires verified bearer identity, not claimed actor fields', async () => {
  expect((await connectorAuthHandler(request(body(), null), 'start')).status).toBe(401);
  expect((await connectorAuthHandler(request({ ...body(), user_id: userId }), 'start')).status).toBe(400);
  expect(start).not.toHaveBeenCalled();
});

it('binds the authenticated actor and requires current manager access', async () => {
  const response = await connectorAuthHandler(request(body()), 'start');
  expect(response.status).toBe(201);
  expect(access).toHaveBeenCalledWith(siteId, userId, true);
  expect(start).toHaveBeenCalledWith({ siteId, userId, toolkitSlug: 'gmail', authConfigId: 'ac_test', nonce });
  expect(await response.text()).not.toContain(token);
});

it('only the disclosed start route records Ask intent; ordinary bodies and callbacks cannot supply it',async()=>{
  expect((await startAsk(request(body(),null))).status).toBe(401);
  access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED','Manager required',403));
  expect((await startAsk(request(body()))).status).toBe(403);
  for(const route of ['start','start-ask'] as const) expect((await connectorAuthHandler(request({...body(),ask_on_connect:true}),route)).status).toBe(400);
  expect((await connectorAuthHandler(request({site_id:siteId,nonce,session_uri:'opaque',ask_on_connect:true}),'complete',attemptId)).status).toBe(400);
  expect(start).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  expect((await startAsk(request(body()))).status).toBe(201);
  expect(start).toHaveBeenCalledWith({siteId,userId,toolkitSlug:'gmail',authConfigId:'ac_test',nonce,askOnConnect:true});
});

it('forwards only strict completion proof and denies URL account claims', async () => {
  expect((await connectorAuthHandler(request({ site_id: siteId, nonce, session_uri: 'opaque', connectedAccountId: 'ca_foreign' }), 'complete', attemptId)).status).toBe(400);
  expect((await connectorAuthHandler(request({ site_id: siteId, nonce, session_uri: 'opaque' }), 'complete', attemptId)).status).toBe(400);
  const continuation = randomBytes(32).toString('hex');
  const response = await connectorAuthHandler(request({ site_id: siteId, nonce, continuation, session_uri: 'opaque' }), 'complete', attemptId);
  expect(response.status).toBe(200);
  expect(finish).toHaveBeenCalledWith({ siteId, userId, nonce, continuation, sessionUri: 'opaque', attemptId });
});

it('starts generic hosted onboarding only for the verified workspace manager and never accepts provider settings', async () => {
  const legacy = { site_id: siteId, toolkit_slug: '_1password', nonce };
  expect((await startHosted(request(legacy))).status).toBe(400);
  const input = { ...legacy, expected_setup: randomBytes(32).toString('hex') };
  delete process.env.CONNECTORS_HOSTED_STARTS_ENABLED;
  const paused = await startHosted(request(input));
  expect(paused.status).toBe(503);
  expect(await paused.json()).toMatchObject({ error: { code: 'HOSTED_STARTS_PAUSED' } });
  process.env.CONNECTORS_HOSTED_STARTS_ENABLED = 'true';
  expect((await startHosted(request(input, null))).status).toBe(401);
  access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED', 'Manager required', 403));
  expect((await startHosted(request(input))).status).toBe(403);
  for (const extra of [{ callback_url: 'https://example.test' }, { user_id: userId }, { scopes: ['all'] }, { ask_on_connect: true }, { setup_mode: 'legacy' }, { credentials: { token } }]) {
    expect((await startHosted(request({ ...input, ...extra }))).status).toBe(400);
  }
  expect(start).not.toHaveBeenCalled();
  expect((await startHosted(request(input))).status).toBe(201);
  expect(start.mock.calls[0][0]).toEqual({ siteId, userId, toolkitSlug: '_1password', nonce, authConfigId: undefined, expectedSetup: input.expected_setup, hosted: true });
});

it('only accepts a request to verify the stored credentials attempt, not a caller supplied provider result', async () => {
  const input = { site_id: siteId, nonce, hosted_credentials: true };
  const submit = (value: unknown) => connectorAuthHandler(request(value), 'complete', attemptId);
  for (const extra of [{ status: 'success' }, { connected_account_id: 'ca_other' }, { session_uri: 'opaque' }, { hosted_credentials: false }]) {
    expect((await submit({ ...input, ...extra })).status).toBe(400);
  }
  expect(finish).not.toHaveBeenCalled();
  expect((await submit(input)).status).toBe(200);
  expect(finish).toHaveBeenCalledWith({ siteId, userId, nonce, attemptId, hostedCredential: true });
});

it('does not return private attempt correlation fields', async () => {
  read.mockResolvedValue({ id: attemptId, user_id: userId, toolkit_slug: 'gmail', status: 'pending', nonce_hash: nonce, credential_revision: nonce, expires_at: '2099-01-01T00:00:00Z' });
  const response = await connectorAuthHandler(new Request(`https://api.example.test/api/connectors/auth-attempts/${attemptId}?site_id=${siteId}`, { headers: { authorization: `Bearer ${token}` } }), 'get', attemptId);
  const data = await response.json();
  expect(data).not.toHaveProperty('nonce_hash');
  expect(data).not.toHaveProperty('credential_revision');
  expect(data.user_id).toBe(userId);
});

it('distinguishes credential authorization read outages before dispatch from later storage errors', async () => {
  const input = { site_id: siteId, nonce, hosted_credentials: true };
  const unavailable = new ConnectorError('STORAGE_UNAVAILABLE', 'Storage unavailable.', 503);
  access.mockRejectedValueOnce(unavailable);
  const preclaim = await connectorAuthHandler(request(input), 'complete', attemptId);
  expect(await preclaim.json()).toMatchObject({ error: { code: 'CREDENTIAL_CHECK_UNAVAILABLE' } });
  expect(finish).not.toHaveBeenCalled();
  finish.mockRejectedValueOnce(unavailable);
  const uncertain = await connectorAuthHandler(request(input), 'complete', attemptId);
  expect(await uncertain.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } });
});
