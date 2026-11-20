import { randomBytes } from 'node:crypto';
import { GET as catalog } from '@/app/api/connectors/catalog/route';
import { GET as detail } from '@/app/api/connectors/catalog/[slug]/route';
import { GET as connectionSummary } from '@/app/api/connectors/connections/[id]/route';
import { GET as connections } from '@/app/api/connectors/connections/route';
import { GET as access, PATCH as patchAccess } from '@/app/api/connectors/connections/[id]/access/route';
import { PATCH as policy } from '@/app/api/connectors/connections/[id]/policy/route';
import { POST as sync } from '@/app/api/connectors/connections/[id]/sync/route';
import { POST as disconnect } from '@/app/api/connectors/connections/[id]/disconnect/route';
import { GET as oldApps } from '@/app/api/agents/apps/list/route';
import { GET as oldIntegrations } from '@/app/api/agents/integrations/list/route';
import { GET as oldDetail } from '@/app/api/agents/integrations/[id]/route';
import { ConnectorError } from '../types';

const getUser = jest.fn();
const siteAccess = jest.fn();
const catalogService = jest.fn();
const detailService = jest.fn();
const updateAccess = jest.fn();
const updatePolicy = jest.fn();
const syncService = jest.fn();
const disconnectService = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: (...args: unknown[]) => getUser(...args) } } }));
jest.mock('../access', () => ({ requireConnectorSiteAccess: (...args: unknown[]) => siteAccess(...args) }));
jest.mock('../catalog-service', () => ({ ...jest.requireActual('../catalog-service'), getConnectorCatalog: (...args: unknown[]) => catalogService(...args), getConnectorDetail: (...args: unknown[]) => detailService(...args) }));
jest.mock('../management', () => ({ ...jest.requireActual('../management'), updateConnectorAccess: (...args: unknown[]) => updateAccess(...args), updateConnectorPolicy: (...args: unknown[]) => updatePolicy(...args) }));
jest.mock('../connection-service', () => ({ ...jest.requireActual('../connection-service'), syncConnector: (...args: unknown[]) => syncService(...args), disconnectConnector: (...args: unknown[]) => disconnectService(...args) }));

const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const token = randomBytes(48).toString('base64url');
const context = { params: Promise.resolve({ id }) };
function request(path = `catalog?site_id=${site}`, body?: unknown, auth = true) {
  return new Request(`https://api.example.test/api/connectors/${path}`, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: user } }, error: null });
  siteAccess.mockResolvedValue({ can_view: true, can_manage: true });
  catalogService.mockResolvedValue({ items: [], configured: false });
  updateAccess.mockResolvedValue({ connector_id: id, revision: 2 });
  updatePolicy.mockResolvedValue({ connector_id: id, revision: 2 });
});

const routes: Array<[string, (request: Request) => Promise<Response>]> = [
  ['catalog', catalog], ['detail', req => detail(req, { params: Promise.resolve({ slug: 'gmail' }) })],
  ['connection summary', req => connectionSummary(req, context)], ['connections', connections], ['access', req => access(req, context)], ['patch access', req => patchAccess(req, context)],
  ['policy', req => policy(req, context)], ['sync', req => sync(req, context)], ['disconnect', req => disconnect(req, context)],
  ['legacy apps', oldApps], ['legacy integrations', oldIntegrations], ['legacy detail', req => oldDetail(req, { params: Promise.resolve({ id: 'gmail' }) })],
];

it.each(routes)('%s independently rejects unverified service/header identity', async (_name, handler) => {
  const req = request(undefined, undefined, false);
  req.headers.set('x-api-key-data', JSON.stringify({ user_id: user, site_id: site, role: 'admin' }));
  req.headers.set('x-site-id', site);
  expect((await handler(req)).status).toBe(401);
  expect(getUser).not.toHaveBeenCalled();
  expect(siteAccess).not.toHaveBeenCalled();
  expect(catalogService).not.toHaveBeenCalled();
});

it('only uses the verified bearer subject, authorizes before catalogue service, and disables caching', async () => {
  const req = request(); req.headers.set('x-user-id', id);
  const response = await catalog(req);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(getUser).toHaveBeenCalledWith(token);
  expect(siteAccess).toHaveBeenCalledWith(site, user);
  expect(catalogService).toHaveBeenCalledWith(user, { site_id: site, tab: 'all' });
});

it.each([`catalog?site_id=${site}&site_id=${site}`, `catalog?site_id=${site}&user_id=${user}`, `catalog?site_id=${site}&tab=shared`, 'catalog?site_id=bad'])('rejects strict query input: %s', async path => {
  expect((await catalog(request(path))).status).toBe(400);
  expect(catalogService).not.toHaveBeenCalled();
});

it('rejects malformed/expired credentials and preserves authentication outages', async () => {
  const malformed = request(); malformed.headers.set('authorization', 'Bearer one two');
  expect((await catalog(malformed)).status).toBe(401);
  getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 401 } });
  expect((await catalog(request())).status).toBe(401);
  getUser.mockRejectedValueOnce(new Error(token));
  const outage = await catalog(request());
  expect(outage.status).toBe(503);
  expect(await outage.text()).not.toContain(token);
  expect(catalogService).not.toHaveBeenCalled();
});

it('fails closed on site access denial or storage failure', async () => {
  for (const error of [new ConnectorError('ACCESS_DENIED', 'Denied.', 403), new Error(token)]) {
    siteAccess.mockRejectedValueOnce(error);
    const response = await catalog(request());
    expect(response.status).toBe(error instanceof ConnectorError ? 403 : 503);
    expect(await response.text()).not.toContain(token);
  }
  expect(catalogService).not.toHaveBeenCalled();
});

it('requires manager authorization before every mutation service', async () => {
  const grants = { site_id: site, expected_revision: 1, members: [{ user_id: user, can_view: true, can_use: false }], agents: [] };
  siteAccess.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  expect((await patchAccess(request('connections', grants), context)).status).toBe(403);
  expect((await policy(request('connections', { site_id: site, expected_revision: 1, enabled: true, allowed_tools: [], allowed_hosts: [], require_approval: true }), context)).status).toBe(403);
  expect((await sync(request('connections', { site_id: site, expected_revision: 1 }), context)).status).toBe(403);
  expect((await disconnect(request('connections', { site_id: site, expected_revision: 1 }), context)).status).toBe(403);
  expect(siteAccess).toHaveBeenCalledWith(site, user, true);
  for (const service of [updateAccess, updatePolicy, syncService, disconnectService]) expect(service).not.toHaveBeenCalled();
});

it('rejects overlong, wrong content-type, malformed JSON, extra fields and missing CAS bodies', async () => {
  const bodies = [{ site_id: site }, { site_id: site, expected_revision: 0 }, { site_id: site, expected_revision: 1, user_id: user }];
  for (const value of bodies) expect((await sync(request('connections', value), context)).status).toBe(400);
  const tooLarge = request('connections', { site_id: site, padding: 'x'.repeat(70_000) });
  expect((await sync(tooLarge, context)).status).toBe(413);
  const invalid = request('connections', {}); invalid.headers.set('content-type', 'text/plain');
  expect((await sync(invalid, context)).status).toBe(415);
  const badJson = new Request('https://api.example.test/api/connectors/connections', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{' });
  expect((await sync(badJson, context)).status).toBe(400);
  expect(syncService).not.toHaveBeenCalled();
});

it('passes only named access updates and returns structured conflict errors', async () => {
  const body = { site_id: site, expected_revision: 1, members: [{ user_id: user, can_view: true, can_use: false }], agents: [] };
  updateAccess.mockRejectedValueOnce(new ConnectorError('REVISION_CONFLICT', 'Reload.', 409));
  const response = await patchAccess(request('connections', body), context);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: 'REVISION_CONFLICT', message: 'Reload.' } });
  expect(updateAccess).toHaveBeenCalledWith(user, id, body);
});