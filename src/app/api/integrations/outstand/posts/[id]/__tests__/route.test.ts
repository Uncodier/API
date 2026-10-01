import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getUser = jest.fn<(...args: unknown[]) => Promise<any>>();
const rpc = jest.fn<(...args: unknown[]) => Promise<any>>();
jest.unstable_mockModule('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser }, rpc }),
}));
jest.unstable_mockModule('next/server', () => ({ NextResponse: { json: Response.json } }));

let GET: typeof import('../route').GET;
let DELETE: typeof import('../route').DELETE;
let WITH_CONTENT: typeof import('../with-content/route').DELETE;
beforeAll(async () => {
  ({ GET, DELETE } = await import('../route'));
  ({ DELETE: WITH_CONTENT } = await import('../with-content/route'));
});
const site = '00000000-0000-4000-8000-000000000001';
const foreign = '00000000-0000-4000-8000-000000000002';
const token = 'a'.repeat(40);
const base = 'https://api.outstand.so/v1';
const context = { params: Promise.resolve({ id: 'post-1' }) };
const account = (id = 'a', changes = {}) => ({
  id, network: 'x', username: id, status: 'published', platformPostId: `remote-${id}`, publishedAt: '2026-01-01T00:00:00Z',
  ...changes,
});
const post = (accounts = [account()], changes = {}) => ({
  success: true, post: {
    id: 'post-1', isDraft: false, publishedAt: '2026-01-01T00:00:00Z', scheduledAt: null, socialAccounts: accounts, ...changes,
  },
});
const inventory = (changes = {}) => ({
  success: true, data: [{ id: 'a', network: 'x', username: 'a', isActive: true, tenant_id: site, ...changes }],
});
const remote = (changes = {}) => ({ success: true, results: [{
  network: 'x', username: 'a', platform_post_id: 'remote-a', status: 'deleted', error: null, ...changes,
}] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const req = (method = 'DELETE', query = `tenant_id=${site}&delete_remote=true`, headers = {}) => new Request(
  `https://api.example.test/api/integrations/outstand/posts/post-1?${query}`, {
    method, headers: { authorization: `Bearer ${token}`, ...headers },
  },
);
let fetchMock: jest.SpiedFunction<typeof fetch>;
beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1', role: 'authenticated' } } });
  rpc.mockReset().mockImplementation(async (name) => ({ data: name === 'user_can' ? true : 'owner' }));
  process.env.OUTSTAND_API_KEY = 'secret-provider-key';
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete process.env.OUTSTAND_API_KEY;
});
const mutations = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE');

describe('secured Outstand GET and DELETE routes', () => {
  it('authenticates, proves every account belongs to site, deletes remote then record, returns markers', async () => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockResolvedValueOnce(json(remote())).mockResolvedValueOnce(json({ success: true, message: 'Deleted' }));
    const res = await DELETE(req(), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, post_id: 'post-1', delete_remote: true });
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      [`${base}/posts/post-1`, 'GET'],
      [`${base}/social-accounts?tenantId=${site}&limit=100&offset=0`, 'GET'],
      [`${base}/posts/post-1/remote`, 'DELETE'], [`${base}/posts/post-1`, 'DELETE'],
    ]);
    for (const [, options] of fetchMock.mock.calls) expect(options).toMatchObject({
      redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
      headers: { Authorization: 'Bearer secret-provider-key', 'X-Tenant-ID': site },
    });
  });

  it('the new with-content path forces remote deletion without relying on a query flag', async () => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockResolvedValueOnce(json(remote())).mockResolvedValueOnce(json({ success: true, message: 'Deleted' }));
    const res = await WITH_CONTENT(req('DELETE', `tenant_id=${site}`), context);
    expect(await res.json()).toEqual({ success: true, post_id: 'post-1', delete_remote: true });
    expect(mutations().map(([url]) => url)).toEqual([`${base}/posts/post-1/remote`, `${base}/posts/post-1`]);
  });

  it.each(['', '&delete_remote=false'])('record-only deletion is default, no remote endpoint: %s', async (query) => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockResolvedValueOnce(json({ success: true, message: 'Deleted' }));
    const res = await DELETE(req('DELETE', `tenant_id=${site}${query}`), context);
    expect(await res.json()).toEqual({ success: true, post_id: 'post-1', delete_remote: false });
    expect(mutations().map(([url]) => url)).toEqual([`${base}/posts/post-1`]);
  });

  it.each([
    { isDraft: true, publishedAt: null },
    { isDraft: false, publishedAt: null, scheduledAt: '2099-01-01T00:00:00Z' },
  ])('cancels draft/future scheduled post without remote endpoint', async (changes) => {
    fetchMock.mockResolvedValueOnce(json(post([account('a', { status: 'pending', platformPostId: null, publishedAt: null })], changes)))
      .mockResolvedValueOnce(json(inventory())).mockResolvedValueOnce(json({ success: true, message: 'Cancelled' }));
    expect((await DELETE(req(), context)).status).toBe(200);
    expect(mutations().map(([url]) => url)).toEqual([`${base}/posts/post-1`]);
  });

  it('secures GET using the same live ownership check and no-store response', async () => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()));
    const res = await GET(req('GET', `tenant_id=${site}`), context);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).post.id).toBe('post-1');
    expect(mutations()).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each(['marketing', 'collaborator', 'owner'])('Next automatic HEAD fallback never mutates for %s', async (role) => {
    rpc.mockResolvedValueOnce({ data: role });
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()));
    const res = await GET(req('HEAD', `tenant_id=${site}`), context);
    expect(res.status).toBe(200);
    expect(mutations()).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each(['true', 'false'])('HEAD rejects delete_remote=%s without authorization or provider access', async (value) => {
    const res = await GET(req('HEAD', `tenant_id=${site}&delete_remote=${value}`), context);
    expect(res.status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'OPTIONS'])('unsupported method %s never reaches provider', async (method) => {
    expect((await DELETE(req(method), context)).status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with-content rejects HEAD rather than falling into remote deletion', async () => {
    expect((await WITH_CONTENT(req('HEAD', `tenant_id=${site}`), context)).status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET returns an allowlisted DTO without provider internals or raw account errors', async () => {
    fetchMock.mockResolvedValueOnce(json(post([account('a', { error: 'raw-secret', accessToken: 'raw-secret' })], {
      orgId: 'raw-secret', credentials: 'raw-secret', containers: [{ content: 'Visible content', internal: 'raw-secret' }],
    }))).mockResolvedValueOnce(json(inventory()));
    const res = await GET(req('GET', `tenant_id=${site}`), context);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('raw-secret');
    expect(body).toContain('Visible content');
  });

  it.each(['tenant_id', 'tenantId', 'site_id', 'siteId'])('rejects contradictory %s metadata at provider boundaries', async (key) => {
    const foreignPost = post();
    fetchMock.mockResolvedValueOnce(json({ ...foreignPost, [key]: foreign }));
    expect((await DELETE(req(), context)).status).toBe(403);
    expect(mutations()).toEqual([]);
    fetchMock.mockResolvedValueOnce(json(post(undefined, { [key]: foreign })));
    expect((await DELETE(req(), context)).status).toBe(403);
    fetchMock.mockResolvedValueOnce(json(post([account('a', { [key]: foreign })])))
      .mockResolvedValueOnce(json(inventory()));
    expect((await DELETE(req(), context)).status).toBe(403);
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json({ ...inventory(), [key]: foreign }));
    expect((await DELETE(req(), context)).status).toBe(502);
    expect(mutations()).toEqual([]);
  });

  it.each([
    { success: false, post: post().post }, { success: true, error: 'raw-secret', post: post().post },
    { success: true, post: { ...post().post, id: 'other-post' } },
  ])('rejects unsuccessful/mismatched provider post envelopes', async (value) => {
    fetchMock.mockResolvedValueOnce(json(value));
    expect((await DELETE(req(), context)).status).toBe(502);
    expect(mutations()).toEqual([]);
  });

  it.each(['GET', 'DELETE'])('%s rejects unauthenticated callers despite forged middleware headers', async (method) => {
    const handler = method === 'GET' ? GET : DELETE;
    const res = await handler(req(handler === GET ? 'GET' : 'DELETE', `tenant_id=${site}`, {
      authorization: '', 'x-auth-user-id': 'owner', 'x-api-key-data': '{"isService":true}',
    }), context);
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies missing tenant access/capability before any provider call', async () => {
    rpc.mockResolvedValueOnce({ data: null });
    expect((await DELETE(req(), context)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['GET', 'DELETE'])('%s does not trust org-shared X-Tenant-ID or foreign-account IDs', async (method) => {
    const handler = method === 'GET' ? GET : DELETE;
    fetchMock.mockResolvedValueOnce(json(post([account('foreign-account')]))).mockResolvedValueOnce(json(inventory()));
    const res = await handler(req(handler === GET ? 'GET' : 'DELETE', `tenant_id=${site}`), context);
    expect(res.status).toBe(403);
    expect(mutations()).toEqual([]);
  });

  it.each([{ tenant_id: foreign }, { tenant_id: undefined }, { tenantId: foreign }])('fails closed on unscoped inventory %j', async (row) => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory(row)));
    expect((await DELETE(req(), context)).status).toBe(502);
    expect(mutations()).toEqual([]);
  });

  it('verifies all inventory pages and all targets before mutation', async () => {
    fetchMock.mockResolvedValueOnce(json(post([account(), account('foreign-account')]))).mockResolvedValueOnce(json({
      success: true, data: inventory().data, limit: 1, offset: 0, total: 2,
    })).mockResolvedValueOnce(json({
      success: true, data: inventory({ id: 'b', username: 'b' }).data, limit: 1, offset: 1, total: 2,
    }));
    expect((await DELETE(req(), context)).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mutations()).toEqual([]);
  });

  it.each([undefined, [], [account(), account()]])('fails closed on absent/duplicate post targets', async (socialAccounts) => {
    fetchMock.mockResolvedValueOnce(json(post(undefined, { socialAccounts }))).mockResolvedValueOnce(json(inventory()));
    expect((await DELETE(req(), context)).status).toBeGreaterThanOrEqual(400);
    expect(mutations()).toEqual([]);
  });

  it('retains provider record on partial deletion even when success=true', async () => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockResolvedValueOnce(json(remote({ status: 'failed', error: 'token=secret provider detail' })));
    const res = await DELETE(req(), context);
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('token=secret');
    expect(mutations().map(([url]) => url)).toEqual([`${base}/posts/post-1/remote`]);
  });

  it('retries per-account deleted state without another remote mutation', async () => {
    fetchMock.mockResolvedValueOnce(json(post([account('a', { status: 'deleted' })])))
      .mockResolvedValueOnce(json(inventory())).mockResolvedValueOnce(json({ success: true, message: 'Deleted' }));
    expect((await DELETE(req(), context)).status).toBe(200);
    expect(mutations().map(([url]) => url)).toEqual([`${base}/posts/post-1`]);
  });

  it.each(['GET', 'DELETE'])('%s preflight 404 is not tenant/remote absence proof', async (method) => {
    const handler = method === 'GET' ? GET : DELETE;
    fetchMock.mockResolvedValueOnce(json({ error: 'secret' }, 404));
    const res = await handler(req(handler === GET ? 'GET' : 'DELETE', `tenant_id=${site}`), context);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('contact support') });
    expect(mutations()).toEqual([]);
  });

  it.each([400, 401, 403, 404, 429, 500])('sanitizes remote HTTP %s and never retries or deletes record', async (status) => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockResolvedValueOnce(json({ error: 'secret-provider-response' }, status));
    const res = await DELETE(req(), context);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret-provider-response');
    expect(mutations()).toHaveLength(1);
  });

  it.each(['malformed', 'empty', 'oversized'])('rejects %s provider remote response with no record deletion', async (kind) => {
    const response = kind === 'oversized'
      ? new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } })
      : new Response(kind === 'empty' ? null : 'not-json', { status: kind === 'empty' ? 204 : 200 });
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory())).mockResolvedValueOnce(response);
    expect((await DELETE(req(), context)).status).toBe(502);
    expect(mutations()).toHaveLength(1);
  });

  it.each([{}, { success: false }, { success: true }, { success: true, message: 'ok', results: [{ status: 'failed' }] }])(
    'requires explicit record deletion confirmation %j', async (value) => {
      fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
        .mockResolvedValueOnce(json(remote())).mockResolvedValueOnce(json(value));
      const res = await DELETE(req(), context);
      expect(res.status).toBe(502);
      expect((await res.json()).success).toBe(false);
    },
  );

  it('record 404 after ownership proof still does not blindly confirm a concurrent deletion', async () => {
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockResolvedValueOnce(json(remote())).mockResolvedValueOnce(json({ error: 'Not found' }, 404));
    expect((await DELETE(req(), context)).status).toBe(502);
  });

  it('bounds total orchestration, aborts upstream and does not continue to record DELETE', async () => {
    jest.useFakeTimers();
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    fetchMock.mockResolvedValueOnce(json(post())).mockResolvedValueOnce(json(inventory()))
      .mockImplementationOnce(async (_input, options) => new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('Abort transport')));
        notifyStarted();
      }));
    const operation = DELETE(req(), context);
    await started;
    await jest.advanceTimersByTimeAsync(70_000);
    const res = await operation;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('timed out') });
    expect(mutations()).toHaveLength(1);
    expect(fetchMock.mock.calls[2][1]?.signal?.aborted).toBe(true);
  });
});