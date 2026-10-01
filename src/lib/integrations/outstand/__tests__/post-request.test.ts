import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getUser = jest.fn<(...args: unknown[]) => Promise<any>>();
const rpc = jest.fn<(...args: unknown[]) => Promise<any>>();
const createClient = jest.fn(() => ({ auth: { getUser }, rpc }));
jest.unstable_mockModule('@supabase/supabase-js', () => ({ createClient }));
let parsePostRequest: typeof import('../post-request').parsePostRequest;
let requirePostSiteAccess: typeof import('../post-request').requirePostSiteAccess;
beforeAll(async () => {
  ({ parsePostRequest, requirePostSiteAccess } = await import('../post-request'));
});

const site = '00000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(40);
const signal = new AbortController().signal;
const request = (method = 'DELETE', headers: Record<string, string> = {}) => new Request(
  `https://api.example.test/posts/post-1?tenant_id=${site}`, {
    method, headers: { authorization: `Bearer ${token}`, ...headers },
  },
);

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: 'user-1', role: 'authenticated' } }, error: null });
  rpc.mockImplementation(async (name) => ({ data: name === 'user_can' ? true : 'owner', error: null }));
});

describe('strict Outstand post query contract', () => {
  it('defaults remote deletion to false and canonicalizes UUID', () => {
    expect(parsePostRequest(request(), 'post-1')).toEqual({ siteId: site, deleteRemote: false });
    expect(parsePostRequest(request(), 'post-1', true).deleteRemote).toBe(true);
  });

  it.each(['', '../post', 'a/b', 'x?remote=true', 'x%2Fy', 'x.y', 'x\n', 'a'.repeat(201)])('rejects unsafe ID %s', (id) => {
    expect(() => parsePostRequest(request(), id)).toThrow();
  });

  it.each([
    '', '?tenant_id=bad', `?tenant_id=${site}&tenant_id=${site}`, `?tenant_id=${site}&delete_remote=True`,
    `?tenant_id=${site}&delete_remote=1`, `?tenant_id=${site}&delete_remote=`,
    `?tenant_id=${site}&delete_remote=true&delete_remote=false`, `?tenant_id=${site}&site_id=${site}`,
  ])('rejects malformed query %s', (query) => {
    expect(() => parsePostRequest(new Request(`https://api.test/posts/p${query}`, { method: 'DELETE' }), 'p')).toThrow();
  });

  it('only accepts exact boolean query values and forbids remote flags on GET/with-content', () => {
    for (const value of ['true', 'false']) {
      const url = `${request().url}&delete_remote=${value}`;
      expect(parsePostRequest(new Request(url, { method: 'DELETE' }), 'p').deleteRemote).toBe(value === 'true');
      expect(() => parsePostRequest(new Request(url), 'p')).toThrow();
      expect(() => parsePostRequest(new Request(url, { method: 'DELETE' }), 'p', true)).toThrow();
    }
  });
});

describe('fresh bearer authentication and user-scoped DELETE capability', () => {
  it('verifies bearer and calls role and capability RPCs under user RLS, not middleware headers', async () => {
    await requirePostSiteAccess(request('DELETE', {
      'x-api-key-data': '{"isService":true}', 'x-auth-user-id': 'forged', 'x-tenant-id': 'foreign',
    }), site, signal);
    expect(getUser).toHaveBeenCalledWith(token);
    expect(rpc.mock.calls).toEqual([
      ['current_user_site_role', { p_site_id: site }], ['user_can', { p_site_id: site, p_command: 'delete' }],
    ]);
    expect(createClient).toHaveBeenCalledWith(expect.any(String), 'test-anon-key', expect.objectContaining({
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${token}` }, fetch: expect.any(Function) },
    }));
  });

  it.each(['', 'Basic abc', 'Bearer short', `Bearer ${token} extra`])('rejects missing/malformed bearer %s', async (authorization) => {
    await expect(requirePostSiteAccess(request('DELETE', { authorization }), site, signal)).rejects.toMatchObject({ status: 401 });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('does not accept an API key instead of user authentication', async () => {
    await expect(requirePostSiteAccess(request('DELETE', { 'x-api-key': 'key' }), site, signal)).rejects.toMatchObject({ status: 401 });
    expect(getUser).not.toHaveBeenCalled();
  });

  it.each([
    { data: { user: null }, error: null },
    { data: { user: { role: 'authenticated', is_anonymous: true } }, error: null },
    { data: { user: { role: 'service_role' } }, error: null },
    { data: { user: { role: 'authenticated' } }, error: new Error('expired') },
  ])('rejects unverified/anonymous users', async (result) => {
    getUser.mockResolvedValueOnce(result);
    await expect(requirePostSiteAccess(request(), site, signal)).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['collaborator', 'marketing', null, 'superadmin'])('denies DELETE role %s', async (role) => {
    rpc.mockResolvedValueOnce({ data: role, error: null });
    await expect(requirePostSiteAccess(request(), site, signal)).rejects.toMatchObject({ status: 403 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([false, null, 'true', 1])('requires exact true from user_can: %s', async (allowed) => {
    rpc.mockResolvedValueOnce({ data: 'admin' }).mockResolvedValueOnce({ data: allowed });
    await expect(requirePostSiteAccess(request(), site, signal)).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed on authorization storage errors', async () => {
    rpc.mockResolvedValueOnce({ data: 'owner', error: { message: 'database detail' } });
    await expect(requirePostSiteAccess(request(), site, signal)).rejects.toMatchObject({ status: 503 });
  });

  it('fails closed if DELETE capability lookup is unavailable', async () => {
    rpc.mockResolvedValueOnce({ data: 'admin' }).mockResolvedValueOnce({ data: true, error: { message: 'database detail' } });
    await expect(requirePostSiteAccess(request(), site, signal)).rejects.toMatchObject({ status: 503 });
  });

  it('permits readonly site members only for GET', async () => {
    rpc.mockResolvedValueOnce({ data: 'marketing' });
    await requirePostSiteAccess(request('GET'), site, signal);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});