import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cloudRevisionBranch, publishCloudRevision } from '../git';
import { CloudFileStoreError, type CloudGitResult, type CloudGitTarget, type CloudRevision, type CloudScope } from '../types';

function fixture() {
  const scope: CloudScope = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID() };
  const content = 'Private notes\r\n日本語';
  let document: CloudRevision = { file_id: randomUUID(), version: 1, name: 'notes.md', mime: 'text/markdown', content,
    bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    instance_id: scope.instanceId, requirement_id: null, git_status: 'pending' };
  const env = { CLOUD_FILES_GITHUB_REPOSITORY: 'example/private-documents',
    CLOUD_FILES_GITHUB_TOKEN: randomBytes(32).toString('hex'), CLOUD_FILES_GITHUB_NO_DEPLOY: 'true' };
  const revisions = new Map([[1, document]]);
  const store = {
    read: jest.fn(async (_scope: CloudScope, _file: string, version?: number) => revisions.get(version ?? 1) ?? null),
    bindGitTarget: jest.fn(async (_scope: CloudScope, _file: string, version: number, target: CloudGitTarget) => {
      const current = revisions.get(version)!;
      if (current.git_repository && (current.git_repository !== target.repository
        || current.git_ref !== target.ref || current.git_path !== target.path)) throw new CloudFileStoreError('operation_mismatch');
      const bound = { ...current, git_repository: target.repository, git_ref: target.ref, git_path: target.path };
      revisions.set(version, bound);
      return bound;
    }),
    setGitResult: jest.fn(async (_scope: CloudScope, _file: string, _version: number, result: CloudGitResult) => {
      const current = revisions.get(_version)!;
      if (current.git_status === 'committed') return current;
      document = { ...current, git_status: result.status, git_commit_sha: result.commitSha };
      revisions.set(_version, document);
      return document;
    }),
  };
  const blobs = new Map<string, any>();
  const trees = new Map<string, any>();
  const commits = new Map<string, any>();
  const refs = new Map<string, string>();
  let privateRepo = true;
  let visibility: string | undefined = 'private';
  let timeoutRef = false;
  let failAll = false;
  const fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (failAll) throw new Error(env.CLOUD_FILES_GITHUB_TOKEN);
    const path = new URL(String(url)).pathname.replace('/repos/example/private-documents', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const response = (data: any, status = 200) => new Response(JSON.stringify(data), { status });
    if (!path) return response({ private: privateRepo, visibility, full_name: env.CLOUD_FILES_GITHUB_REPOSITORY });
    if (path === '/commits' && method === 'GET') return response([{ sha: 'a'.repeat(40) }]);
    if (method === 'POST') {
      if (path === '/git/blobs') {
        const bytes = Buffer.from(body.content, 'base64');
        const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        blobs.set(sha, { ...body, sha, size: bytes.length });
        return response({ sha }, 201);
      }
      const sha = createHash('sha1').update(JSON.stringify(body)).digest('hex');
      if (path === '/git/trees') { trees.set(sha, { tree: body.tree, sha, truncated: false }); return response({ sha }, 201); }
      if (path === '/git/commits') { commits.set(sha, { ...body, sha, tree: { sha: body.tree } }); return response({ sha }, 201); }
      if (path === '/git/refs') {
        if (refs.has(body.ref)) return response({}, 422);
        refs.set(body.ref, body.sha);
        if (timeoutRef) throw new Error(env.CLOUD_FILES_GITHUB_TOKEN);
        return response({}, 201);
      }
    }
    if (path.startsWith('/git/ref/')) {
      const ref = `refs/${path.slice('/git/ref/'.length)}`;
      const sha = refs.get(ref);
      return sha ? response({ ref, object: { sha, type: 'commit' } }) : response({}, 404);
    }
    for (const [prefix, values] of [['/git/blobs/', blobs], ['/git/trees/', trees], ['/git/commits/', commits]] as const) {
      if (path.startsWith(prefix)) return response(values.get(path.slice(prefix.length)) ?? {}, values.has(path.slice(prefix.length)) ? 200 : 404);
    }
    throw new Error('Unexpected offline request');
  });
  const assertActive = jest.fn(async () => {});
  return { scope, document, env, store, fetch, assertActive, refs, blobs, commits, revisions,
    visibility: (value: string | undefined) => { visibility = value; },
    private: (value: boolean) => { privateRepo = value; }, timeout: () => { timeoutRef = true; },
    fail: () => { failAll = true; } };
}

test('fails closed without dedicated configuration; never uses application token fallback', async () => {
  const f = fixture();
  for (const env of [{}, { GITHUB_TOKEN: randomBytes(32).toString('hex') },
    { ...f.env, CLOUD_FILES_GITHUB_NO_DEPLOY: 'false' }, { ...f.env, CLOUD_FILES_GITHUB_TOKEN: undefined }]) {
    await expect(publishCloudRevision(f.scope, f.document, { ...f, env })).rejects.toMatchObject({ code: 'unconfigured' });
  }
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.store.setGitResult).not.toHaveBeenCalled();
});

test.each([409, 200])('empty repository (%s) stays unbound and pending until explicitly initialized', async status => {
  const f = fixture(); const transport = f.fetch.getMockImplementation()!;
  let initialized = false;
  f.fetch.mockImplementation((url, init) => {
    if (!initialized && new URL(String(url)).pathname.endsWith('/commits')) {
      return Promise.resolve(new Response(JSON.stringify(status === 200 ? [] : { message: 'Git Repository is empty.' }), { status }));
    }
    return transport(url, init);
  });
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'repository_uninitialized' });
  expect(f.store.bindGitTarget).not.toHaveBeenCalled();
  expect(f.store.setGitResult).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  expect(f.revisions.get(1)?.git_status).toBe('pending');
  initialized = true;
  expect((await publishCloudRevision(f.scope, f.document, f)).git_status).toBe('committed');
});

test.each([[], [{ sha: 'invalid' }], { message: 'denied' }])('unverified repository history never permits uploads: %j', payload => {
  // Empty successful history has its explicit initialization classification;
  // malformed history must not be interpreted as an initialized repository.
  const f = fixture(); const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url, init) => new URL(String(url)).pathname.endsWith('/commits')
    ? Promise.resolve(new Response(JSON.stringify(payload))) : transport(url, init));
  return publishCloudRevision(f.scope, f.document, f).then(() => { throw new Error('Unexpected publication'); }, error => {
    expect(['repository_uninitialized', 'unavailable']).toContain(error.code);
    expect(f.store.bindGitTarget).not.toHaveBeenCalled();
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});

test('denies public repositories before uploading any document bytes', async () => {
  const f = fixture(); f.private(false);
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'private_repository_required' });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.fetch.mock.calls[0][1]?.method).toBe('GET');
  expect(f.store.setGitResult).not.toHaveBeenCalled();
  expect(f.store.bindGitTarget).not.toHaveBeenCalled();
  expect(f.revisions.get(1)?.git_repository).toBeUndefined();
  f.private(true);
  expect((await publishCloudRevision(f.scope, f.document, f)).git_status).toBe('committed');
});

test.each(['internal', 'public', undefined])('rejects private flag with non-private/missing visibility %s', async visibility => {
  const f = fixture(); f.visibility(visibility);
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'private_repository_required' });
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  expect(f.refs.size).toBe(0);
  expect(f.store.bindGitTarget).not.toHaveBeenCalled();
  expect(f.store.setGitResult).not.toHaveBeenCalled();
});

test.each([404, 403, 503])('inaccessible initial target %s leaves pending revision unbound', async status => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response('{}', { status }));
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.store.bindGitTarget).not.toHaveBeenCalled();
  expect(f.store.setGitResult).not.toHaveBeenCalled();
  expect(f.revisions.get(1)?.git_repository).toBeUndefined();
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  expect((await publishCloudRevision(f.scope, f.document, f)).git_status).toBe('committed');
});

test('binds after read-only privacy preflight but before document requests and includes immutable receipt fields', async () => {
  const f = fixture();
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (f.fetch.mock.calls.length <= 2) {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(f.store.bindGitTarget).not.toHaveBeenCalled();
    } else {
      expect(f.revisions.get(1)).toMatchObject({ git_repository: f.env.CLOUD_FILES_GITHUB_REPOSITORY,
        git_ref: `refs/heads/${cloudRevisionBranch(f.scope, f.document)}`, git_path: f.document.name });
    }
    return transport(url, init);
  });
  const result = await publishCloudRevision(f.scope, f.document, f);
  expect(result).toMatchObject({ git_repository: f.env.CLOUD_FILES_GITHUB_REPOSITORY,
    git_ref: `refs/heads/${cloudRevisionBranch(f.scope, f.document)}`, git_path: f.document.name });
});

test.each(['committed', 'pending'] as const)('changed configuration cannot move a bound %s revision', async status => {
  const f = fixture();
  if (status === 'committed') await publishCloudRevision(f.scope, f.document, f);
  else await f.store.bindGitTarget(f.scope, f.document.file_id, 1, { repository: f.env.CLOUD_FILES_GITHUB_REPOSITORY,
    ref: `refs/heads/${cloudRevisionBranch(f.scope, f.document)}`, path: f.document.name });
  f.fetch.mockClear(); f.store.bindGitTarget.mockClear(); f.store.setGitResult.mockClear();
  await expect(publishCloudRevision(f.scope, f.document, { ...f,
    env: { ...f.env, CLOUD_FILES_GITHUB_REPOSITORY: 'example/other-private-documents' },
  })).rejects.toMatchObject({ code: 'configuration_mismatch' });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.store.bindGitTarget).not.toHaveBeenCalled();
  expect(f.revisions.get(1)?.git_repository).toBe(f.env.CLOUD_FILES_GITHUB_REPOSITORY);
  expect(f.store.setGitResult).not.toHaveBeenCalled();
  expect(f.revisions.get(1)?.git_status).toBe(status);
  expect((await publishCloudRevision(f.scope, f.document, f)).git_status).toBe('committed');
});

test.each(['ref', 'path'] as const)('rejects mismatched bound %s before provider access', async field => {
  const f = fixture();
  f.revisions.set(1, { ...f.document, git_repository: f.env.CLOUD_FILES_GITHUB_REPOSITORY,
    git_ref: field === 'ref' ? 'refs/heads/other' : `refs/heads/${cloudRevisionBranch(f.scope, f.document)}`,
    git_path: field === 'path' ? 'other.md' : f.document.name });
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'configuration_mismatch' });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.store.setGitResult).not.toHaveBeenCalled();
});

test('concurrent incompatible target binding mismatch never mutates provider or durable status', async () => {
  const f = fixture();
  f.store.bindGitTarget.mockRejectedValueOnce(new CloudFileStoreError('operation_mismatch'));
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'configuration_mismatch' });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.fetch.mock.calls[0][1]?.method).toBe('GET');
  expect(f.store.setGitResult).not.toHaveBeenCalled();
});

test('binding outage never starts provider publication', async () => {
  const f = fixture();
  f.store.bindGitTarget.mockRejectedValueOnce(new Error(f.env.CLOUD_FILES_GITHUB_TOKEN));
  const error = await publishCloudRevision(f.scope, f.document, f).catch(error => error);
  expect(error.code).toBe('unavailable');
  expect(String(error)).not.toContain(f.env.CLOUD_FILES_GITHUB_TOKEN);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.fetch.mock.calls[0][1]?.method).toBe('GET');
});

test('previous committed revision from another repository cannot be used as parent', async () => {
  const f = fixture();
  const previous = await publishCloudRevision(f.scope, f.document, f);
  f.revisions.set(1, { ...previous, git_repository: 'example/previous-private-documents' });
  const next = { ...f.document, version: 2 };
  f.revisions.set(2, next);
  f.fetch.mockClear();
  f.store.setGitResult.mockClear();
  await expect(publishCloudRevision(f.scope, next, f)).rejects.toMatchObject({ code: 'configuration_mismatch' });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.store.setGitResult).not.toHaveBeenCalled();
  f.revisions.set(1, previous);
  expect((await publishCloudRevision(f.scope, next, f)).git_status).toBe('committed');
});

test('rechecks repository privacy after ref lookup and before uploading bytes', async () => {
  const f = fixture();
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const result = await transport(url, init);
    if (String(url).includes('/git/ref/')) f.private(false);
    return result;
  });
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'private_repository_required' });
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('cannot expose committed success when durable status remains pending', async () => {
  const f = fixture();
  f.store.setGitResult.mockResolvedValue(f.document);
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'unavailable' });
});

test('verifies exact remote bytes then persists committed; reuses immutable branch without writes', async () => {
  const f = fixture();
  const first = await publishCloudRevision(f.scope, f.document, f);
  expect(first.git_status).toBe('committed');
  expect(f.refs.size).toBe(1);
  expect(f.assertActive.mock.calls.length).toBeGreaterThanOrEqual(f.fetch.mock.calls.length);
  for (const [url, init] of f.fetch.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/example\/private-documents/);
    expect(init?.redirect).toBe('error');
    expect(init?.method).not.toBe('PATCH');
  }
  f.fetch.mockClear();
  const replay = await publishCloudRevision(f.scope, f.document, f);
  expect(replay.git_commit_sha).toBe(first.git_commit_sha);
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('recovers ambiguous successful ref timeout by reading, never issuing duplicate ref POST', async () => {
  const f = fixture(); f.timeout();
  const result = await publishCloudRevision(f.scope, f.document, f);
  expect(result.git_status).toBe('committed');
  expect(f.fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/git/refs') && init?.method === 'POST')).toHaveLength(1);
});

test('concurrent publishers converge on the same immutable verified ref', async () => {
  const f = fixture();
  const results = await Promise.all([
    publishCloudRevision(f.scope, f.document, f), publishCloudRevision(f.scope, f.document, f),
  ]);
  expect(results[0].git_commit_sha).toBe(results[1].git_commit_sha);
  expect(results.every(result => result.git_status === 'committed')).toBe(true);
  expect(f.refs.size).toBe(1);
});

test('database completion outage leaves recoverable ref; retry verifies without further remote writes', async () => {
  const f = fixture();
  f.store.setGitResult.mockRejectedValueOnce(new Error(f.env.CLOUD_FILES_GITHUB_TOKEN));
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.refs.size).toBe(1);
  f.fetch.mockClear();
  const recovered = await publishCloudRevision(f.scope, f.document, f);
  expect(recovered.git_status).toBe('committed');
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('transport failure after initial missing ref never claims pending is committed', async () => {
  const f = fixture();
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') throw new Error(f.env.CLOUD_FILES_GITHUB_TOKEN);
    return transport(url, init);
  });
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.refs.size).toBe(0);
  expect(f.store.setGitResult).not.toHaveBeenCalled();
});

test('preserves previous committed revision as parent when available', async () => {
  const f = fixture();
  const previous = await publishCloudRevision(f.scope, f.document, f);
  const next = { ...f.document, version: 2 };
  f.revisions.set(2, next);
  const published = await publishCloudRevision(f.scope, next, f);
  expect(f.commits.get(published.git_commit_sha!)?.parents).toEqual([previous.git_commit_sha]);
});

test('ref at expected location with wrong payload metadata is conflict, never overwritten', async () => {
  const f = fixture();
  await publishCloudRevision(f.scope, f.document, f);
  for (const commit of f.commits.values()) commit.message = 'wrong metadata';
  f.fetch.mockClear();
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('scoped store denial makes no GitHub request and reveals no raw authentication secret', async () => {
  const f = fixture();
  const username = randomBytes(12).toString('hex');
  const password = randomBytes(32).toString('hex');
  const url = new URL('https://example.invalid/private');
  url.username = username; url.password = password;
  f.store.read.mockRejectedValue(new Error(`${url} ${f.env.CLOUD_FILES_GITHUB_TOKEN}`));
  const error = await publishCloudRevision(f.scope, f.document, f).catch(error => error);
  for (const value of [username, password, f.env.CLOUD_FILES_GITHUB_TOKEN]) {
    expect(String(error)).not.toContain(value);
    expect(JSON.stringify(error)).not.toContain(value);
  }
  expect(f.fetch).not.toHaveBeenCalled();
});

test('remote content mismatch fails closed without replacing ref or recording committed', async () => {
  const f = fixture();
  await publishCloudRevision(f.scope, f.document, f);
  for (const blob of f.blobs.values()) blob.content = Buffer.from('different').toString('base64');
  f.fetch.mockClear(); f.store.setGitResult.mockClear();
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  expect(f.store.setGitResult.mock.calls.every(call => call[3].status !== 'committed')).toBe(true);
});

test('verified remote content conflict still marks a pending bound revision conflict', async () => {
  const f = fixture();
  const published = await publishCloudRevision(f.scope, f.document, f);
  f.revisions.set(1, { ...published, git_status: 'pending', git_commit_sha: null });
  for (const blob of f.blobs.values()) blob.content = Buffer.from('different').toString('base64');
  f.fetch.mockClear(); f.store.setGitResult.mockClear();
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.revisions.get(1)?.git_status).toBe('conflict');
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('no raw secrets escape transport errors and ambiguous errors preserve pending intent', async () => {
  const f = fixture(); f.fail();
  const error = await publishCloudRevision(f.scope, f.document, f).catch(error => error);
  expect(error.code).toBe('unavailable');
  expect(String(error)).not.toContain(f.env.CLOUD_FILES_GITHUB_TOKEN);
  expect(JSON.stringify(error)).not.toContain(f.env.CLOUD_FILES_GITHUB_TOKEN);
  expect(f.store.setGitResult).not.toHaveBeenCalled();
  expect(f.store.bindGitTarget).not.toHaveBeenCalled();
  expect(f.revisions.get(1)?.git_repository).toBeUndefined();
});

test('checks active execution before each remote request, aborting before the next mutation', async () => {
  const f = fixture();
  f.assertActive.mockImplementation(async () => { if (f.fetch.mock.calls.length >= 3) throw new Error('inactive'); });
  await expect(publishCloudRevision(f.scope, f.document, f)).rejects.toMatchObject({ code: 'inactive' });
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('branch identity isolates site, instance, file and version but not actor changes', () => {
  const f = fixture();
  const branch = cloudRevisionBranch(f.scope, f.document);
  expect(cloudRevisionBranch({ ...f.scope, userId: randomUUID() }, f.document)).toBe(branch);
  expect(cloudRevisionBranch({ ...f.scope, siteId: randomUUID() }, f.document)).not.toBe(branch);
  expect(cloudRevisionBranch({ ...f.scope, instanceId: randomUUID() }, f.document)).not.toBe(branch);
  expect(cloudRevisionBranch(f.scope, { ...f.document, version: 2 })).not.toBe(branch);
  expect(cloudRevisionBranch(f.scope, { ...f.document, file_id: randomUUID() })).not.toBe(branch);
});