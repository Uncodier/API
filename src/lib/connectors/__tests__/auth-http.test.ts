import { randomBytes } from 'node:crypto';
import { connectorAuthHandler } from '../auth-http';

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

it('forwards only strict completion proof and denies URL account claims', async () => {
  expect((await connectorAuthHandler(request({ site_id: siteId, nonce, session_uri: 'opaque', connectedAccountId: 'ca_foreign' }), 'complete', attemptId)).status).toBe(400);
  const response = await connectorAuthHandler(request({ site_id: siteId, nonce, session_uri: 'opaque' }), 'complete', attemptId);
  expect(response.status).toBe(200);
  expect(finish).toHaveBeenCalledWith({ siteId, userId, nonce, sessionUri: 'opaque', attemptId });
});

it('does not return private attempt correlation fields', async () => {
  read.mockResolvedValue({ id: attemptId, user_id: userId, toolkit_slug: 'gmail', status: 'pending', nonce_hash: nonce, credential_revision: nonce, expires_at: '2099-01-01T00:00:00Z' });
  const response = await connectorAuthHandler(new Request(`https://api.example.test/api/connectors/auth-attempts/${attemptId}?site_id=${siteId}`, { headers: { authorization: `Bearer ${token}` } }), 'get', attemptId);
  const data = await response.json();
  expect(data).not.toHaveProperty('nonce_hash');
  expect(data).not.toHaveProperty('credential_revision');
  expect(data.user_id).toBe(userId);
});