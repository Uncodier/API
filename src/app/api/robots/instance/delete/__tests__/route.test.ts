import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { POST } from '../route';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/robot-instance/delete-remote-instance-children', () => ({ deleteRemoteInstanceChildren: jest.fn() }));

const { supabaseAdmin } = jest.requireMock('@/lib/database/supabase-client');
const { deleteRemoteInstanceChildren } = jest.requireMock('@/lib/services/robot-instance/delete-remote-instance-children');

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const SITE = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000003';
const CREATOR = '00000000-0000-4000-8000-000000000004';
const REQUIREMENT = '00000000-0000-4000-8000-000000000005';
const OTHER = '00000000-0000-4000-8000-000000000006';
const PREFLIGHT = 'get_robot_instance_deletion_scope';
const DELETE = 'delete_robot_instance_with_requirements';
const TOKEN = randomBytes(48).toString('base64url');
const ANON_KEY = randomBytes(32).toString('hex');
const PROVIDER_KEY = randomBytes(32).toString('hex');
const PRIVATE_ERROR = `private database detail ${randomBytes(12).toString('hex')}`;
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const getUser = jest.fn();
const rpc = jest.fn();
const from = jest.fn();
const fetchMock = jest.fn();
const payload = { instance_id: INSTANCE, delete_requirements: true };
const baseScope = {
  instance_id: INSTANCE, site_id: SITE, requirement_ids: [REQUIREMENT],
  provider: 'scrapybara', provider_instance_id: 'provider-instance', status: 'paused',
};
const receipt = { instance_id: INSTANCE, deleted_requirement_ids: [REQUIREMENT] };

function request(body: unknown = payload, headers: Record<string, string> = {}, suffix = '') {
  return new NextRequest(`https://api.example.test/api/robots/instance/delete${suffix}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function setScope(data: unknown) {
  rpc.mockImplementation(async (name: string) => ({ data: name === PREFLIGHT ? data : receipt, error: null }));
}

function failRpc(stage: string, code: string) {
  rpc.mockImplementation(async (name: string) => name === stage
    ? { data: null, error: { code, message: PRIVATE_ERROR, details: TOKEN, hint: PROVIDER_KEY } }
    : { data: name === PREFLIGHT ? baseScope : receipt, error: null });
}

async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  expect(text).not.toContain(PRIVATE_ERROR);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(PROVIDER_KEY);
  expect(JSON.parse(text)).toEqual({ success: false, error: { code, message: expect.any(String) } });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch = fetchMock;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://auth.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = randomBytes(32).toString('hex');
  process.env.SCRAPYBARA_API_KEY = PROVIDER_KEY;
  (createClient as jest.Mock).mockReturnValue({ auth: { getUser }, rpc, from });
  getUser.mockResolvedValue({ data: { user: { id: OWNER, role: 'authenticated', is_anonymous: false } }, error: null });
  setScope(baseScope);
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  // No direct table updates/deletes, service access, or old partial log cleanup on any path.
  expect(from).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deleteRemoteInstanceChildren).not.toHaveBeenCalled();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

afterAll(() => {
  global.fetch = originalFetch;
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SCRAPYBARA_API_KEY']) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

it('accepts an authorized site owner who is not the instance creator; confirms the exact receipt', async () => {
  setScope({ ...baseScope, created_by: CREATOR });
  const response = await POST(request(payload, { 'x-user-id': CREATOR, 'x-site-id': OTHER }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, ...receipt, message: expect.any(String) });
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(createClient).toHaveBeenCalledWith('https://auth.example.test', ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${TOKEN}` }, fetch: expect.any(Function) },
  });
  expect(getUser).toHaveBeenCalledWith(TOKEN);
  expect(rpc.mock.calls).toEqual([
    [PREFLIGHT, { p_instance_id: INSTANCE }],
    [DELETE, { p_instance_id: INSTANCE, p_expected_requirement_ids: [REQUIREMENT],
      p_expected_provider: 'scrapybara', p_expected_provider_instance_id: 'provider-instance', p_expected_status: 'paused' }],
  ]);
  expect(getUser.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]);
  expect(fetchMock).toHaveBeenCalledWith('https://api.scrapybara.com/v1/instance/provider-instance/stop', {
    method: 'POST', headers: { 'x-api-key': PROVIDER_KEY, 'Content-Type': 'application/json' },
    signal: expect.any(AbortSignal), redirect: 'error', cache: 'no-store',
  });
});

it.each(['', 'Basic credentials', `Bearer ${TOKEN} extra`, `Bearer ${'a'.repeat(4200)}`])(
  'rejects absent or malformed bearer %# despite middleware identity', async authorization => {
    await expectFailure(await POST(request(payload, { authorization, 'x-user-id': OWNER, 'x-site-id': SITE })), 401, 'unauthorized');
    expect(createClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('rejects API-key authentication even alongside a bearer', async () => {
  await expectFailure(await POST(request(payload, { 'x-api-key': randomBytes(32).toString('hex') })), 401, 'unauthorized');
  expect(createClient).not.toHaveBeenCalled();
});

it.each([
  { data: { user: null }, error: null },
  { data: { user: { id: OWNER, role: 'authenticated' } }, error: { status: 401, message: PRIVATE_ERROR } },
  { data: { user: { id: OWNER, role: 'authenticated', is_anonymous: true } }, error: null },
  { data: { user: { id: OWNER, role: 'service_role' } }, error: null },
  { data: { user: { role: 'authenticated' } }, error: null },
])('requires getUser to confirm an authenticated, nonanonymous user %#', async result => {
  getUser.mockResolvedValue(result);
  await expectFailure(await POST(request()), 401, 'unauthorized');
  expect(rpc).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['rejection', 'server error'])('fails closed on auth infrastructure %s', async kind => {
  if (kind === 'rejection') getUser.mockRejectedValue(new Error(PRIVATE_ERROR));
  else getUser.mockResolvedValue({ data: { user: null }, error: { status: 503, message: PRIVATE_ERROR } });
  await expectFailure(await POST(request()), 503, 'deletion_unavailable');
  expect(rpc).not.toHaveBeenCalled();
});

it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])('requires anon config %s without a service-role fallback', async name => {
  delete process.env[name];
  await expectFailure(await POST(request()), 503, 'deletion_unavailable');
  expect(createClient).not.toHaveBeenCalled();
});

it.each([
  {}, { instance_id: INSTANCE }, { instance_id: INSTANCE, delete_requirements: false },
  { instance_id: INSTANCE, delete_requirements: 'true' }, { instance_id: 'not-a-uuid', delete_requirements: true },
  { ...payload, site_id: SITE }, { ...payload, user_id: OWNER }, { ...payload, provider_instance_id: 'foreign' },
  { ...payload, expected_requirement_ids: [] }, null, [], '{broken',
])('rejects invalid or client-controlled deletion input %#', async body => {
  await expectFailure(await POST(request(body)), 400, 'invalid_request');
  expect(rpc).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  [JSON.stringify(payload), { 'content-type': 'text/plain' }, ''],
  [JSON.stringify(payload), {}, '?site_id=untrusted'],
  [JSON.stringify(payload), { 'content-length': '4097' }, ''],
  [`${JSON.stringify(payload)}${' '.repeat(4096)}`, {}, ''],
])('bounds bytes, rejects wrong content types and queries %#', async (body, headers, suffix) => {
  await expectFailure(await POST(request(body, headers as Record<string, string>, suffix)), 400, 'invalid_request');
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  ['PT403', 403, 'forbidden'], ['PT404', 404, 'not_found'], ['PT409', 409, 'deletion_conflict'],
  ['PT401', 401, 'unauthorized'], ['PGRST301', 401, 'unauthorized'],
  ['PGRST202', 503, 'deletion_unavailable'], ['PGRST203', 503, 'deletion_unavailable'],
  ['42883', 503, 'deletion_unavailable'], ['42P01', 503, 'deletion_unavailable'], ['42703', 503, 'deletion_unavailable'],
])('stops before the provider for forbidden/cross-site/shared/missing preflight %s', async (code, status, publicCode) => {
  failRpc(PREFLIGHT, String(code));
  await expectFailure(await POST(request()), Number(status), String(publicCode));
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  null, [], {}, { ...baseScope, instance_id: OTHER }, { ...baseScope, site_id: null },
  { ...baseScope, requirement_ids: [REQUIREMENT, REQUIREMENT] }, { ...baseScope, requirement_ids: ['foreign'] },
  { ...baseScope, requirement_ids: Array(1001).fill(REQUIREMENT) }, { ...baseScope, provider: undefined },
])('requires a complete, bounded, same-instance preflight %#', async scope => {
  setScope(scope);
  await expectFailure(await POST(request()), 503, 'deletion_unavailable');
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['stopped', 'uninstantiated'])('skips provider for %s and sends the null provider CAS fields', async status => {
  setScope({ ...baseScope, status, provider: null, provider_instance_id: null });
  expect((await POST(request())).status).toBe(200);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenLastCalledWith(DELETE, expect.objectContaining({
    p_expected_provider: null, p_expected_provider_instance_id: null, p_expected_status: status,
  }));
});

it.each(['pending', 'running'])('allows a preflight-verified %s instance with no provider or sandbox', async status => {
  setScope({ ...baseScope, status, provider: null, provider_instance_id: null });
  expect((await POST(request())).status).toBe(200);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenLastCalledWith(DELETE, expect.objectContaining({
    p_expected_provider: null, p_expected_provider_instance_id: null, p_expected_status: status,
  }));
});

it('does not skip authorization of execution/sandbox safety just because a provider ID is absent', async () => {
  failRpc(PREFLIGHT, 'PT409');
  await expectFailure(await POST(request()), 409, 'deletion_conflict');
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([null, 'unknown', 'vercel'])('fails closed for active unsupported provider %s', async provider => {
  setScope({ ...baseScope, provider });
  await expectFailure(await POST(request()), 409, 'unsupported_provider');
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([null, '', '../other-instance', 'https://other.example.test'])('does not invent or trust a provider target %s', async id => {
  setScope({ ...baseScope, provider_instance_id: id });
  await expectFailure(await POST(request()), 409, 'deletion_conflict');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('does not attempt cleanup without provider configuration', async () => {
  delete process.env.SCRAPYBARA_API_KEY;
  await expectFailure(await POST(request()), 503, 'deletion_unavailable');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});

it.each([400, 401, 404, 409, 500, 'network'])('does not delete DB data or retry after provider stop failure %s', async status => {
  if (status === 'network') fetchMock.mockRejectedValue(new Error(PRIVATE_ERROR));
  else fetchMock.mockResolvedValue(new Response(PRIVATE_ERROR, { status: Number(status) }));
  await expectFailure(await POST(request()), 502, 'provider_stop_failed');
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ['PT403', 403, 'forbidden'], ['PT404', 404, 'not_found'], ['PT409', 409, 'deletion_conflict'],
  ['PGRST202', 503, 'deletion_unavailable'], ['42883', 503, 'deletion_unavailable'],
  ['23503', 500, 'deletion_failed'], ['57014', 500, 'deletion_failed'], ['', 502, 'deletion_unconfirmed'],
])('maps atomic RPC failure %s without partial fallback or retry', async (code, status, publicCode) => {
  failRpc(DELETE, String(code));
  await expectFailure(await POST(request()), Number(status), String(publicCode));
  expect(rpc.mock.calls.map(call => call[0])).toEqual([PREFLIGHT, DELETE]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  null, [], {}, { ...receipt, instance_id: OTHER }, { ...receipt, deleted_requirement_ids: [] },
  { ...receipt, deleted_requirement_ids: [OTHER] }, { ...receipt, deleted_requirement_ids: [REQUIREMENT, REQUIREMENT] },
  { ...receipt, deleted_requirement_ids: ['invalid'] }, { instance_id: INSTANCE },
])('requires an exact receipt, never treating an empty/malformed response as success %#', async data => {
  rpc.mockImplementation(async (name: string) => ({ data: name === PREFLIGHT ? baseScope : data, error: null }));
  await expectFailure(await POST(request()), 502, 'deletion_unconfirmed');
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('passes all expected IDs exactly once and accepts reordered confirmed IDs', async () => {
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === PREFLIGHT
    ? { ...baseScope, requirement_ids: [REQUIREMENT, OTHER] }
    : { ...receipt, deleted_requirement_ids: [OTHER, REQUIREMENT] } }));
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect((await response.json()).deleted_requirement_ids).toEqual([OTHER, REQUIREMENT]);
  expect(rpc).toHaveBeenLastCalledWith(DELETE, expect.objectContaining({ p_expected_requirement_ids: [REQUIREMENT, OTHER] }));
});

it('can delete an instance with no requirements only when that empty scope is confirmed', async () => {
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === PREFLIGHT
    ? { ...baseScope, requirement_ids: [] } : { ...receipt, deleted_requirement_ids: [] } }));
  expect((await POST(request())).status).toBe(200);
  expect(rpc).toHaveBeenLastCalledWith(DELETE, expect.objectContaining({ p_expected_requirement_ids: [] }));
});

it('never retries a thrown/ambiguous mutation failure', async () => {
  rpc.mockImplementation(async (name: string) => {
    if (name === DELETE) throw new Error(PRIVATE_ERROR);
    return { data: baseScope, error: null };
  });
  await expectFailure(await POST(request()), 502, 'deletion_unconfirmed');
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('does not start external or database mutation when the caller cancels during preflight', async () => {
  let finishPreflight!: (value: unknown) => void;
  const enteredPreflight = new Promise<void>(resolve => {
    rpc.mockImplementation(() => { resolve(); return new Promise(finish => { finishPreflight = finish; }); });
  });
  const controller = new AbortController();
  const req = new NextRequest(request(), { signal: controller.signal });
  const response = POST(req);
  await enteredPreflight;
  controller.abort();
  await expectFailure(await response, 502, 'deletion_unconfirmed');
  finishPreflight({ data: baseScope, error: null });
  await Promise.resolve();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('bounds authorization even if the authentication transport never settles', async () => {
  jest.useFakeTimers();
  getUser.mockImplementation(() => new Promise(() => {}));
  const response = POST(request());
  await jest.advanceTimersByTimeAsync(550_001);
  await expectFailure(await response, 502, 'deletion_unconfirmed');
  expect(rpc).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('bounds a hung provider stop, aborts transport and never proceeds to deletion', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const response = POST(request());
  await jest.advanceTimersByTimeAsync(550_001);
  await expectFailure(await response, 502, 'provider_stop_failed');
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('bounds a hung atomic RPC without retrying or claiming rollback', async () => {
  jest.useFakeTimers();
  rpc.mockImplementation((name: string) => name === DELETE ? new Promise(() => {}) : Promise.resolve({ data: baseScope, error: null }));
  const response = POST(request());
  await jest.advanceTimersByTimeAsync(550_001);
  await expectFailure(await response, 502, 'deletion_unconfirmed');
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('bounds streamed auth/RPC responses and rejects redirects using the scoped transport', async () => {
  await POST(request());
  const transport = (createClient as jest.Mock).mock.calls[0][2].global.fetch;
  fetchMock.mockResolvedValue(new Response('x'.repeat(128 * 1024 + 1)));
  await expect(transport('https://auth.example.test/auth/v1/user', { method: 'GET' })).rejects.toThrow();
  expect(fetchMock).toHaveBeenLastCalledWith('https://auth.example.test/auth/v1/user', expect.objectContaining({
    method: 'GET', signal: expect.any(AbortSignal), redirect: 'error', cache: 'no-store',
  }));
});

it.each([PREFLIGHT, DELETE])('logs only the stage and SQLSTATE for a coded %s failure', async rpcName => {
  failRpc(rpcName, '23503');
  await expectFailure(await POST(request()), 500, 'deletion_failed');
  expect(console.error).toHaveBeenCalledWith('[instance/delete] Failed', {
    stage: rpcName === PREFLIGHT ? 'preflight' : 'database_deletion',
    status: 500, code: 'deletion_failed', database_code: '23503',
  });
  const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
  for (const sensitive of [TOKEN, ANON_KEY, PROVIDER_KEY, PRIVATE_ERROR, INSTANCE]) {
    expect(logged).not.toContain(sensitive);
  }
});

it('does not log an arbitrary provider error code as a SQLSTATE', async () => {
  failRpc(PREFLIGHT, TOKEN);
  await expectFailure(await POST(request()), 500, 'deletion_failed');
  expect(console.error).toHaveBeenCalledWith('[instance/delete] Failed', {
    stage: 'preflight', status: 500, code: 'deletion_failed', database_code: null,
  });
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(TOKEN);
});