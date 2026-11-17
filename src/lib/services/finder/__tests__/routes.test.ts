import { NextRequest } from 'next/server';
import { POST } from '@/app/api/finder/person_role_search/createQuery/route';
import { GET, DELETE } from '@/app/api/finder/icp/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import { requireFinderActor, authorizeFinderCreate, requireFinderPermission, FinderError } from '../ownership';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/utils/api-response-utils', () => ({ logError: jest.fn(), logInfo: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: {
  PRICING: { PERSON_ROLE_SEARCH: 1 }, validateCredits: jest.fn(), deductCredits: jest.fn(),
} }));
jest.mock('../ownership', () => {
  const actual = jest.requireActual('../ownership');
  return { ...actual, requireFinderActor: jest.fn(), authorizeFinderCreate: jest.fn(), requireFinderPermission: jest.fn() };
});

const site = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const icp = '33333333-3333-4333-8333-333333333333';
const role = '44444444-4444-4444-8444-444444444444';
const segment = '55555555-5555-4555-8555-555555555555';
const userClient = { from: jest.fn(), rpc: jest.fn() };

function builder(result: unknown) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'eq', 'in', 'limit', 'upsert', 'insert', 'delete', 'single', 'maybeSingle']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.then = jest.fn((resolve) => Promise.resolve(result).then(resolve));
  return chain;
}
function request(body: unknown = { site_id: site, query: { title: 'Engineer' } }) {
  return new NextRequest('https://api.example.test/api/finder/person_role_search/createQuery', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}
function loadRequest(method = 'GET', extra = '') {
  return new NextRequest(`https://api.example.test/api/finder/icp?icp_id=${icp}${extra}`, { method });
}

beforeEach(() => {
  jest.clearAllMocks();
  (supabaseAdmin.from as jest.Mock).mockReset();
  userClient.from.mockReset();
  (requireFinderActor as jest.Mock).mockResolvedValue({ client: userClient, userId: actor });
  (authorizeFinderCreate as jest.Mock).mockResolvedValue(undefined);
  (requireFinderPermission as jest.Mock).mockResolvedValue(undefined);
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
  (CreditService.deductCredits as jest.Mock).mockResolvedValue(undefined);
});

test.each([POST, GET, DELETE])('authentication failure never reaches admin or billing', async handler => {
  (requireFinderActor as jest.Mock).mockRejectedValue(new FinderError(401, 'Unauthorized'));
  expect((await handler(request())).status).toBe(401);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
});

test.each([{ site_id: 'invalid', query: {} }, { site_id: site, query: [] }, { site_id: site, segment_id: 'bad' }, []])(
  'invalid create input does not bill or write: %j', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

test.each([403, 404, 503])('site/segment preflight fails closed (%i)', async status => {
  (authorizeFinderCreate as jest.Mock).mockRejectedValue(new FinderError(status, 'Denied'));
  expect((await POST(request({ site_id: site, segment_id: segment, query: {} }))).status).toBe(status);
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test.each([false, true])('create sets verified ownership, strips metadata, scopes dedup and race (%s)', async race => {
  const rq = builder({ data: { id: role, query_hash: 'db-hash', query: { title: 'Engineer', page: 0 } }, error: null });
  const active = builder({ data: [], error: null });
  const insert = builder(race ? { data: null, error: { code: '23505' } }
    : { data: { id: icp, status: 'pending', total_targets: 0 }, error: null });
  const raced = builder({ data: [{ id: icp, status: 'pending' }], error: null });
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(rq).mockReturnValueOnce(active)
    .mockReturnValueOnce(insert).mockReturnValueOnce(raced);
  const response = await POST(request({ site_id: site, user_id: 'forged', query: {
    title: 'Engineer', page: '0', user_id: 'forged', created_by: 'forged', owner_id: 'forged', name: 'metadata',
  } }));
  expect(response.status).toBe(200);
  expect((await response.json()).icp_mining.reused).toBe(race);
  expect(rq.upsert.mock.calls[0][0][0].query).toEqual({ title: 'Engineer', page: 0 });
  const row = insert.insert.mock.calls[0][0][0];
  expect(row.user_id).toBe(actor);
  expect(row.icp_criteria.user_id).toBe(actor);
  for (const lookup of race ? [active, raced] : [active]) {
    expect(lookup.eq).toHaveBeenCalledWith('user_id', actor);
    expect(lookup.eq).toHaveBeenCalledWith('site_id', site);
    expect(lookup.eq).toHaveBeenCalledWith('icp_criteria', JSON.stringify(row.icp_criteria));
  }
  expect(authorizeFinderCreate).toHaveBeenCalledWith(userClient, site, actor, undefined);
  expect((authorizeFinderCreate as jest.Mock).mock.invocationCallOrder[0])
    .toBeLessThan((CreditService.validateCredits as jest.Mock).mock.invocationCallOrder[0]);
});

test('active reuse avoids inserting a new list', async () => {
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(builder({ data: { id: role, query: {}, query_hash: 'hash' } }))
    .mockReturnValueOnce(builder({ data: [{ id: icp, status: 'running' }] }));
  const response = await POST(request());
  expect((await response.json()).icp_mining.reused).toBe(true);
  expect(supabaseAdmin.from).toHaveBeenCalledTimes(2);
});

test.each(['GET', 'DELETE'])('%s invisible list cannot reach admin', async method => {
  userClient.from.mockReturnValue(builder({ data: method === 'GET' ? [] : null, error: null }));
  const response = await (method === 'GET' ? GET : DELETE)(loadRequest(method));
  expect(response.status).toBe(404);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('GET loads shared query only after scoped visibility, honors optional site', async () => {
  const visible = builder({ data: [{ id: icp, site_id: site, role_query_id: role }] });
  userClient.from.mockReturnValue(visible);
  (supabaseAdmin.from as jest.Mock).mockReturnValue(builder({ data: { id: role, query: {} } }));
  expect((await GET(loadRequest('GET', `&site_id=${site}`))).status).toBe(200);
  expect(visible.eq).toHaveBeenCalledWith('site_id', site);
  expect(userClient.from.mock.invocationCallOrder[0]).toBeLessThan((supabaseAdmin.from as jest.Mock).mock.invocationCallOrder[0]);
});

test('selected-only GET returns marker and no searchable query or admin lookup', async () => {
  userClient.from.mockReturnValue(builder({ data: [{ id: icp, site_id: site,
    icp_criteria: { source: 'selected_people' }, total_targets: 2 }] }));
  const response = await GET(loadRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ icp_mining: { source: 'selected_people', total_targets: 2 }, role_query: null });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('DELETE checks permission and mutates through RLS, not admin', async () => {
  const deletion = builder({ data: [{ id: icp }] });
  userClient.from.mockReturnValueOnce(builder({ data: { id: icp, site_id: site } })).mockReturnValueOnce(deletion);
  expect((await DELETE(loadRequest('DELETE'))).status).toBe(200);
  expect(requireFinderPermission).toHaveBeenCalledWith(userClient, site, 'delete');
  expect(deletion.delete).toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('DELETE permission denial does not mutate', async () => {
  userClient.from.mockReturnValue(builder({ data: { id: icp, site_id: site } }));
  (requireFinderPermission as jest.Mock).mockRejectedValue(new FinderError(403, 'Denied'));
  expect((await DELETE(loadRequest('DELETE'))).status).toBe(403);
  expect(userClient.from).toHaveBeenCalledTimes(1);
});

test.each([GET, DELETE])('raw database errors are not returned', async handler => {
  userClient.from.mockReturnValue(builder({ data: null, error: { message: 'private SQL detail' } }));
  const response = await handler(loadRequest());
  expect(response.status).toBeGreaterThanOrEqual(500);
  expect(JSON.stringify(await response.json())).not.toContain('private SQL detail');
});