import { POST as create } from '@/app/api/finder/lists/route';
import { POST as append } from '@/app/api/finder/lists/[id]/people/route';
import { authorizeFinderCreate, requireFinderActor, requireFinderPermission, FinderError } from '../ownership';

jest.mock('../ownership', () => ({ ...jest.requireActual('../ownership'),
  authorizeFinderCreate: jest.fn(), requireFinderActor: jest.fn(), requireFinderPermission: jest.fn(),
}));
const site = '11111111-1111-4111-8111-111111111111';
const list = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const client = { rpc: jest.fn(), from: jest.fn() };
const body = { site_id: site, name: 'Selected leads', person_ids: ['person:abc-1'], request_id: requestId };
function request(value: unknown = body) {
  return new Request('https://api.example.test/api/finder/lists', { method: 'POST', body: JSON.stringify(value) });
}
function appendRequest(value: unknown = { site_id: site, person_ids: body.person_ids, request_id: requestId }, id = list) {
  return append(request(value), { params: Promise.resolve({ id }) });
}
beforeEach(() => {
  jest.resetAllMocks();
  (requireFinderActor as jest.Mock).mockResolvedValue({ client, userId: list });
  (authorizeFinderCreate as jest.Mock).mockResolvedValue(undefined);
  (requireFinderPermission as jest.Mock).mockResolvedValue(undefined);
  const chain: any = {};
  for (const key of ['select', 'eq']) chain[key] = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({ data: { id: list, site_id: site } });
  client.from.mockReturnValue(chain);
  client.rpc.mockResolvedValue({ data: { list: { id: list, site_id: site, name: 'Selected leads', status: 'pending', total_targets: 1, private_field: 'hidden' }, added_count: 1 } });
});
test.each([create, appendRequest])('authentication is independent and fails closed', async handler => {
  (requireFinderActor as jest.Mock).mockRejectedValue(new FinderError(401, 'Unauthorized'));
  expect((await handler(request())).status).toBe(401);
  expect(client.rpc).not.toHaveBeenCalled();
});
test.each([
  { ...body, user_id: list }, { ...body, created_by: list }, { ...body, site_id: 'bad' },
  { ...body, request_id: undefined }, { ...body, name: '' }, { ...body, person_ids: [] },
  { ...body, person_ids: Array(101).fill('abc') }, { ...body, person_ids: ['bad/id'] },
  { ...body, person_ids: ['a'.repeat(257)] }, { ...body, person_ids: [null] }, [],
])('invalid/forged input rejected: %j', async value => {
  expect((await create(request(value))).status).toBe(400);
  expect(client.rpc).not.toHaveBeenCalled();
});
test('bounded stream rejects body even without content length', async () => {
  const response = await create(request({ ...body, name: 'x'.repeat(40001) }));
  expect(response.status).toBe(413);
  expect(client.rpc).not.toHaveBeenCalled();
});
test('create uses atomic user RPC and minimal DTO, without billing or provider imports', async () => {
  const response = await create(request());
  expect(response.status).toBe(200);
  expect(client.rpc).toHaveBeenCalledWith('finder_create_selected_list', {
    p_site_id: site, p_name: body.name, p_person_ids: body.person_ids, p_request_id: requestId,
  });
  expect(await response.json()).not.toHaveProperty('list.private_field');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
test.each([403, 404, 503])('create preflight fails closed %s', async status => {
  (authorizeFinderCreate as jest.Mock).mockRejectedValue(new FinderError(status, 'Denied'));
  expect((await create(request())).status).toBe(status);
  expect(client.rpc).not.toHaveBeenCalled();
});
test('append verifies visible site and update before RPC', async () => {
  expect((await appendRequest()).status).toBe(200);
  expect(requireFinderPermission).toHaveBeenCalledWith(client, site, 'update');
  expect(client.rpc).toHaveBeenCalledWith('finder_append_selected_people', {
    p_list_id: list, p_site_id: site, p_person_ids: body.person_ids, p_request_id: requestId,
  });
  expect(client.from().eq).toHaveBeenCalledWith('site_id', site);
});
test('hidden append list and denied update never mutate', async () => {
  client.from().maybeSingle.mockResolvedValueOnce({ data: null });
  expect((await appendRequest()).status).toBe(404);
  (requireFinderPermission as jest.Mock).mockRejectedValue(new FinderError(403, 'Denied'));
  expect((await appendRequest()).status).toBe(403);
  expect(client.rpc).not.toHaveBeenCalled();
});
test.each([['42501', 403], ['22023', 400], ['23505', 409], ['P0002', 404], ['XX000', 503]])('safe RPC failure %s', async (code, status) => {
  client.rpc.mockResolvedValue({ error: { code, message: 'private database detail' } });
  const response = await create(request());
  expect(response.status).toBe(status);
  expect(JSON.stringify(await response.json())).not.toContain('private database detail');
});