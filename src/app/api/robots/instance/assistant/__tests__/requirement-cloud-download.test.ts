import { createHash, randomBytes, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import { GET } from '../../[instanceId]/cloud-files/[fileId]/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { createCloudFileStore, CloudFileStoreError } from '@/lib/cloud-files/store';
import type { CloudRevision } from '@/lib/cloud-files/types';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: jest.fn() }, from: jest.fn() } }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: jest.fn() }));
jest.mock('@/lib/cloud-files/store', () => ({
  CloudFileStoreError: jest.requireActual('@/lib/cloud-files/types').CloudFileStoreError,
  createCloudFileStore: jest.fn(),
}));

function fixture() {
  const instanceId = randomUUID();
  const fileId = randomUUID();
  const userId = randomUUID();
  const siteId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const content = '\ufeff<script>not executable</script>\r\nCafé 日本語\t\n';
  const revision: CloudRevision = { file_id: fileId, instance_id: instanceId, requirement_id: randomUUID(), version: 7,
    name: 'notes/source.html', mime: 'text/html', content, bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'), git_status: 'pending' };
  const read = jest.fn(async () => revision as CloudRevision | null);
  jest.mocked(createCloudFileStore).mockReturnValue({ read } as unknown as ReturnType<typeof createCloudFileStore>);
  jest.mocked(supabaseAdmin.auth.getUser).mockResolvedValue({ data: { user: { id: userId } }, error: null } as any);
  jest.mocked(assertToolScreenAccess).mockResolvedValue(undefined);
  const maybeSingle = jest.fn(async () => ({ data: { site_id: siteId }, error: null }));
  const eq = jest.fn(() => ({ maybeSingle }));
  const select = jest.fn(() => ({ eq }));
  jest.mocked(supabaseAdmin.from).mockReturnValue({ select } as any);
  const request = (options: { query?: string; authorization?: string | null; headers?: Record<string, string> } = {}) => {
    const url = new URL(`https://download.example.test/api/robots/instance/${instanceId}/cloud-files/${fileId}`);
    url.search = options.query ?? '?version=7';
    const headers = new Headers(options.headers);
    if (options.authorization !== null) headers.set('authorization', options.authorization ?? `Bearer ${token}`);
    return GET(new NextRequest(url, { headers }), { params: Promise.resolve({ instanceId, fileId }) });
  };
  return { instanceId, fileId, userId, siteId, token, revision, read, request, maybeSingle, eq,
    scope: { instanceId, siteId, userId } };
}

beforeEach(() => jest.resetAllMocks());

test.each([null, 'Basic ignored'])('download without bearer identity (%s) is denied before any data access', async authorization => {
  const f = fixture();
  const response = await f.request({ authorization, headers: { 'x-user-id': f.userId, 'x-site-id': f.siteId } });
  expect(response.status).toBe(401);
  expect(supabaseAdmin.auth.getUser).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

test('invalid token is denied even when caller forges trusted identity headers', async () => {
  const f = fixture();
  jest.mocked(supabaseAdmin.auth.getUser).mockResolvedValue({ data: { user: null }, error: new Error(f.token) } as any);
  const response = await f.request({ headers: { 'x-user-id': f.userId, 'x-site-id': f.siteId } });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain(f.token);
  expect(supabaseAdmin.auth.getUser).toHaveBeenCalledWith(f.token);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

test('foreign site access fails closed before the revision store is opened', async () => {
  const f = fixture();
  jest.mocked(assertToolScreenAccess).mockRejectedValue(Object.assign(new Error('Foreign site'), { status: 403 }));
  const response = await f.request({ headers: { 'x-site-id': randomUUID(), 'x-user-id': randomUUID() } });
  expect(response.status).toBe(403);
  expect(assertToolScreenAccess).toHaveBeenCalledWith('read_cloud_file', f.scope);
  expect(createCloudFileStore).not.toHaveBeenCalled();
});

test.each(['forbidden', 'not_found'] as const)('foreign file/revision %s uses authenticated scope and returns no content', async code => {
  const f = fixture();
  f.read.mockRejectedValue(new CloudFileStoreError(code));
  const response = await f.request({ query: `?version=7&site_id=${randomUUID()}&user_id=${randomUUID()}` });
  expect(response.status).toBe(code === 'forbidden' ? 403 : 404);
  expect(f.read).toHaveBeenCalledWith(f.scope, f.fileId, 7);
  expect(await response.text()).not.toContain(f.revision.content);
});

test.each(['', '?version=0', '?version=-1', '?version=1.5', '?version=abc', '?version=2147483648', '?version=7&format=html'])
  ('invalid or unspecified exact version/format %s is rejected before authentication', async query => {
    const f = fixture();
    const response = await f.request({ query });
    expect(response.status).toBe(400);
    expect(supabaseAdmin.auth.getUser).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

test('text download returns exact version bytes with inert MIME, private caching and safe filename', async () => {
  const f = fixture();
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(f.revision.content));
  expect(f.read).toHaveBeenCalledWith(f.scope, f.fileId, 7);
  expect(f.eq).toHaveBeenCalledWith('id', f.instanceId);
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${f.fileId}-v7.txt"`);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(response.headers.get('x-cloud-file-sha256')).toBe(f.revision.sha256);
  expect(assertToolScreenAccess).toHaveBeenCalledTimes(3);
  expect(JSON.stringify([...response.headers])).not.toContain(f.token);
});

test('ZIP download integrates the real archive: one exact source entry, no credentials or metadata', async () => {
  const f = fixture();
  const response = await f.request({ query: '?version=7&format=zip' });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/zip');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${f.fileId}-v7.zip"`);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  expect(Object.keys(zip.files)).toEqual([f.revision.name]);
  const bytes = await zip.file(f.revision.name)!.async('nodebuffer');
  expect(bytes).toEqual(Buffer.from(f.revision.content));
  expect(bytes.toString()).not.toContain(f.token);
  expect(JSON.stringify([...response.headers])).not.toContain(f.token);
  expect(f.read).toHaveBeenCalledTimes(3);
  for (const call of f.read.mock.calls) expect(call).toEqual([f.scope, f.fileId, 7]);
});

test('missing historical revision does not silently serve latest', async () => {
  const f = fixture();
  f.read.mockResolvedValue(null);
  expect((await f.request({ query: '?version=3' })).status).toBe(404);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledWith(f.scope, f.fileId, 3);
});

test('revoked permission after reading content prevents the response body from escaping', async () => {
  const f = fixture();
  jest.mocked(assertToolScreenAccess).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Object.assign(new Error('Revoked'), { status: 403 }));
  const response = await f.request();
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(f.revision.content);
});

test('text revision deleted during the authorized second read returns no stale bytes', async () => {
  const f = fixture();
  f.read.mockResolvedValueOnce(f.revision).mockResolvedValueOnce(null);
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(f.read).toHaveBeenCalledTimes(2);
  for (const call of f.read.mock.calls) expect(call).toEqual([f.scope, f.fileId, 7]);
  expect(await response.text()).not.toContain(f.revision.content);
});

test('corrupt content hash is refused rather than downloaded', async () => {
  const f = fixture();
  f.read.mockResolvedValue({ ...f.revision, content: 'Corrupted source' });
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('Corrupted source');
});

test('unexpected backend error cannot expose synthetic credentials or an authenticated URL', async () => {
  const f = fixture();
  const username = randomBytes(12).toString('hex');
  const password = randomBytes(24).toString('hex');
  const queryToken = randomBytes(24).toString('hex');
  const url = new URL('https://private.example.test/repository');
  url.username = username;
  url.password = password;
  url.searchParams.set('token', queryToken);
  f.read.mockRejectedValue(new Error(`Bearer ${f.token} ${url.toString()}`));
  const response = await f.request();
  expect(response.status).toBe(503);
  const visible = `${JSON.stringify([...response.headers])} ${await response.text()}`;
  for (const secret of [f.token, username, password, queryToken]) expect(visible).not.toContain(secret);
  expect(visible).toContain('Cloud files unavailable');
});