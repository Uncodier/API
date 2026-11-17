import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { authorizeFinderCreate, requireFinderActor } from '../ownership';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const segment = '33333333-3333-4333-8333-333333333333';
const auth = { getUser: jest.fn() };
const client = { auth, rpc: jest.fn(), from: jest.fn() };
const visible = () => {
  const chain: Record<string, jest.Mock> = {};
  for (const name of ['select', 'eq']) chain[name] = jest.fn().mockReturnValue(chain);
  chain.maybeSingle = jest.fn().mockResolvedValue({ data: { id: site }, error: null });
  return chain;
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://auth.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = randomBytes(32).toString('hex');
  (createClient as jest.Mock).mockReturnValue(client);
  auth.getUser.mockResolvedValue({ data: { user: { id: user, role: 'authenticated' } }, error: null });
  client.from.mockImplementation(visible);
  client.rpc.mockImplementation(async name => ({ data: name.includes('restrictions') ? false : true, error: null }));
});

test('verified bearer creates isolated user-scoped client', async () => {
  const token = randomBytes(32).toString('hex');
  const request = new Request('https://api.example.test', { headers: { authorization: `Bearer ${token}`, 'x-user-id': 'forged' } });
  expect(await requireFinderActor(request)).toEqual({ client, userId: user });
  expect(auth.getUser).toHaveBeenCalledWith(token);
  expect((createClient as jest.Mock).mock.calls[0][2].global.headers.Authorization).toBe(`Bearer ${token}`);
});

test.each([{}, { 'x-api-key-data': '{"user_id":"forged"}' }, { authorization: 'Bearer short' },
  { authorization: `Bearer ${randomBytes(32).toString('hex')}`, 'x-api-key': randomBytes(32).toString('hex') }])(
  'missing/forged/service identity fails closed', async headers => {
    await expect(requireFinderActor(new Request('https://api.example.test', { headers: headers as Record<string, string> }))).rejects.toMatchObject({ status: 401 });
    expect(createClient).not.toHaveBeenCalled();
  });

test.each([{ id: user, role: 'authenticated', is_anonymous: true }, { id: user, role: 'service_role' }, null])(
  'only a verified authenticated nonanonymous user is an actor', async identity => {
    auth.getUser.mockResolvedValue({ data: { user: identity }, error: null });
    await expect(requireFinderActor(new Request('https://api.example.test', {
      headers: { authorization: `Bearer ${randomBytes(32).toString('hex')}` },
    }))).rejects.toMatchObject({ status: 401 });
  });

test('optional segment is checked with its site and user RLS', async () => {
  const segmentQuery = visible();
  client.from.mockReturnValueOnce(visible()).mockReturnValueOnce(segmentQuery);
  await authorizeFinderCreate(client as never, site, user, segment);
  expect(client.from).toHaveBeenNthCalledWith(2, 'segments');
  expect(segmentQuery.eq).toHaveBeenCalledWith('id', segment);
  expect(segmentQuery.eq).toHaveBeenCalledWith('site_id', site);
  expect(client.rpc).toHaveBeenCalledWith('user_can', { p_site_id: site, p_command: 'insert' });
});

test('no segment is required', async () => {
  await authorizeFinderCreate(client as never, site, user);
  expect(client.from).toHaveBeenCalledTimes(1);
});

test('invisible supplied segment fails closed', async () => {
  const hidden = visible();
  hidden.maybeSingle.mockResolvedValue({ data: null, error: null });
  client.from.mockReturnValueOnce(visible()).mockReturnValueOnce(hidden);
  await expect(authorizeFinderCreate(client as never, site, user, segment)).rejects.toMatchObject({ status: 404 });
});

describe.each(['current_user_has_location_restrictions', 'current_user_has_site_location_restrictions'])('%s', guard => {
  test.each([true, null, undefined])('nonfalse location restriction denies: %s', async value => {
    client.rpc.mockImplementation(async name => ({ data: name === guard ? value : name.includes('restrictions') ? false : true, error: null }));
    await expect(authorizeFinderCreate(client as never, site, user)).rejects.toMatchObject({ status: 403 });
  });
  test('guard error denies', async () => {
    client.rpc.mockImplementation(async name => name === guard ? { error: { message: 'private' } }
      : { data: name.includes('restrictions') ? false : true, error: null });
    await expect(authorizeFinderCreate(client as never, site, user)).rejects.toMatchObject({ status: 503 });
  });
});