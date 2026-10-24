import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointRequirementWorkspace, type RequirementCheckpointOptions, type RequirementCheckpointPublicationIntent } from '../requirement-checkpoint';
import { createRedactor } from '../security';
import { WorkspaceError } from '../workspace';
import type { Workspace } from '../types';

jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
const hash = (value: string) => createHash('sha1').update(value).digest('hex');
const blob = (value: string) => hash(`blob ${Buffer.byteLength(value)}\0${value}`);
const HEAD = hash('baseline commit');
const REMOTE = hash('latest remote commit');
const SAVED = hash('host checkpoint commit');
const TREE = hash('remote tree');
const NEW_TREE = hash('created tree');
const requirementId = randomUUID();
const branch = `feature/req-${requirementId}--checkpoint`;
type Entry = { path: string; mode: string; type: string; sha: string };
const entry = (path: string, text: string, mode = '100644', type = 'blob'): Entry => ({ path, mode, type, sha: blob(text) });
function listingOutput(command: string, text: string) {
  const data = Buffer.from(text);
  const offset = Number(/"offset":(\d+)/.exec(command)?.[1] || 0);
  return { exitCode: 0, stderr: '', stdout: JSON.stringify({ total: data.length,
    digest: createHash('sha256').update(data).digest('hex'), data: data.subarray(offset, offset + 32768).toString('base64') }) };
}

function fixture(local: Record<string, string | Error> = { 'src/main.ts': 'export const value = 2;' }, base: Entry[] = [entry('src/main.ts', 'export const value = 1;')]) {
  const token = randomBytes(32).toString('hex');
  const username = randomBytes(12).toString('hex');
  const workspace = { ref: { provider: 'vercel', id: randomUUID(), root: '/vercel/sandbox' },
    exec: jest.fn(async ({ command }: { command: string }) => command.includes('ls-files') ? listingOutput(command,
      command.includes('"changed":true') ? Object.keys(local).map(p => p + '\0').join('') :
      command.includes('--stage') ? base.map(e => `${e.mode} ${e.sha} 0\t${e.path}\0`).join('') :
      command.includes('"-v"') ? base.map(e => `H ${e.path}\0`).join('') : Object.keys(local).map(p => p + '\0').join('')) :
      { exitCode: 0, stderr: '', stdout: command.includes('rev-parse') ? HEAD + '\n' : branch + '\n' }),
    readFile: jest.fn(async (path: string) => { const value = local[path]; if (value instanceof Error) throw value; return value; }),
  } as unknown as Workspace;
  let remoteSha = HEAD;
  let remoteTree = base;
  const calls: Array<{ path: string; method: string; body: any; init: RequestInit }> = [];
  const mock = jest.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/repos/test-owner/checkpoint', '') + url.search;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, init });
    expect(url.origin).toBe('https://api.github.com');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    let data: unknown;
    if (path.startsWith('/git/ref/')) data = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: remoteSha } };
    else if (path.startsWith('/compare/')) data = { status: 'ahead', merge_base_commit: { sha: path.split('/').pop()!.split('...')[0] } };
    else if (path.startsWith('/git/commits/')) { const sha = path.split('/').pop(); data = { sha, tree: { sha: sha === HEAD ? TREE : hash('latest tree') } }; }
    else if (path.startsWith('/git/trees/')) data = { truncated: false, tree: path.includes(TREE) ? base : remoteTree };
    else if (path === '/git/trees' && method === 'POST') data = { sha: NEW_TREE };
    else if (path === '/git/commits' && method === 'POST') data = { sha: SAVED };
    else if (path.startsWith('/git/refs/') && method === 'PATCH') { remoteSha = body.sha; data = { object: { sha: remoteSha } }; }
    else if (path.startsWith('/git/blobs/')) {
      const text = 'export const value = 1;'; data = { sha: blob(text), encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) };
    } else throw new Error('Unexpected offline request');
    return new Response(JSON.stringify(data), { status: 200 });
  });
  global.fetch = mock as typeof fetch;
  const options: RequirementCheckpointOptions = { run: { requirementId, siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1, sessionId: randomUUID() },
    workspace, repositoryUrl: 'https://github.com/test-owner/checkpoint.git', branch,
    git: { username, password: token, allowPush: true }, redact: createRedactor([username, token]),
    assertActive: jest.fn(async () => {}), preparePublication: jest.fn(async () => {}), signal: new AbortController().signal };
  return { options, workspace, local, calls, mock, token, username, base,
    remote(sha: string, tree: Entry[]) { remoteSha = sha; remoteTree = tree; } };
}
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

it('creates only inspected worktree content on latest remote tree, advisory skip CI and nonforced ref update', async () => {
  const f = fixture();
  const excluded = entry('.env.local', randomBytes(12).toString('hex'));
  f.base.push(excluded);
  const result = await checkpointRequirementWorkspace(f.options);
  expect(result).toMatchObject({ state: 'saved', sha: SAVED, repoUrl: `https://github.com/test-owner/checkpoint/tree/${SAVED}`, baseline: { headSha: HEAD, commitSha: SAVED, files: { 'src/main.ts': blob(f.local['src/main.ts'] as string) } } });
  expect(f.calls.find(c => c.path === '/git/trees')!.body).toEqual({ base_tree: TREE, tree: [{ path: 'src/main.ts', mode: '100644', type: 'blob', content: f.local['src/main.ts'] }] });
  expect(f.calls.find(c => c.path === '/git/commits')!.body).toEqual({ message: 'Requirement workspace checkpoint [skip ci]', tree: NEW_TREE, parents: [HEAD] });
  expect(f.calls.find(c => c.method === 'PATCH')!.body).toEqual({ sha: SAVED, force: false });
  expect(JSON.stringify(result)).not.toContain(f.token);
  expect(JSON.stringify(result)).not.toContain(f.username);
  for (const [input] of (f.workspace.exec as jest.Mock).mock.calls) {
    expect(input.command).not.toMatch(/\s(?:push|commit|reset|checkout|add)(?:\s|$)/);
    expect(input.command).not.toContain(f.token);
    expect(input.command).toContain('core.fsmonitor=false');
  }
});

it('preserves unrelated remote additions and modifications using latest remote parent', async () => {
  const f = fixture();
  f.remote(REMOTE, [...f.base, entry('remote-only.ts', 'export const remote = true;')]);
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'saved' });
  expect(f.calls.find(c => c.path === '/git/commits')!.body.parents).toEqual([REMOTE]);
  expect(f.calls.find(c => c.path === '/git/trees')!.body.base_tree).toBe(hash('latest tree'));
});

it.each([false, true])('creates missing requirement branch from a GitHub verified base; lost ACK=%s', async lostAck => {
  const f = fixture();
  const normal = f.mock.getMockImplementation()!;
  let created = false;
  f.mock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: HEAD } }));
    if (url.includes('/git/ref/heads/') && !created) return new Response('{}', { status: 404 });
    if (url.endsWith('/git/refs') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ ref: `refs/heads/${branch}`, sha: SAVED });
      created = true; f.remote(SAVED, f.base);
      if (lostAck) throw new Error(f.token);
      return new Response(JSON.stringify({ object: { sha: SAVED } }));
    }
    return normal(input, init);
  });
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'saved', sha: SAVED });
  expect(f.mock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  expect(f.mock.mock.calls.filter(([input, init]) => String(input).endsWith('/git/refs') && init?.method === 'POST')).toHaveLength(1);
});

it('checkpoints subsequent edits without moving sandbox HEAD using host manifest', async () => {
  const f = fixture();
  const first = await checkpointRequirementWorkspace(f.options);
  expect(first.state).toBe('saved');
  f.remote(SAVED, [entry('src/main.ts', f.local['src/main.ts'] as string)]);
  f.local['src/main.ts'] = 'export const value = 3;';
  expect(await checkpointRequirementWorkspace({ ...f.options, baseline: first.baseline })).toMatchObject({ state: 'saved' });
});

it.each([false, true])('recovers durable pending publication after lost ACK and failed receipt; changed=%s', async changed => {
  const f = fixture();
  f.local['src/main.ts'] = 'export const value = 1;';
  const confirmed = await checkpointRequirementWorkspace(f.options);
  expect(confirmed.state).toBe('unchanged');
  f.local['src/main.ts'] = 'export const value = 2;';
  let pending: RequirementCheckpointPublicationIntent | undefined;
  f.options.preparePublication = async intent => { pending = structuredClone(intent); };
  const normal = f.mock.getMockImplementation()!;
  let published = false;
  f.mock.mockImplementation(async (input, init) => {
    if (init?.method === 'PATCH') {
      expect(pending?.baseline.commitSha).toBe(SAVED);
      await normal(input, init); published = true; throw new Error('lost ACK');
    }
    if (published) throw new Error('receipt verification unavailable');
    return normal(input, init);
  });
  expect((await checkpointRequirementWorkspace({ ...f.options, baseline: confirmed.baseline })).state).toBe('unknown');
  expect(pending).toMatchObject({ parentSha: HEAD, expectedSha: SAVED, createRef: false });
  f.mock.mockImplementation(normal);
  f.remote(SAVED, [entry('src/main.ts', f.local['src/main.ts'] as string)]);
  if (changed) f.local['src/main.ts'] = 'export const value = 4;';
  const exec = f.workspace.exec as jest.Mock;
  const capture = exec.getMockImplementation()!;
  f.calls.length = 0;
  exec.mockImplementation(async (...args) => {
    expect(f.calls[0].path).toMatch(/^\/git\/ref\//);
    return capture(...args);
  });
  const recovered = await checkpointRequirementWorkspace({ ...f.options, baseline: confirmed.baseline, pendingPublication: pending });
  expect(recovered).toMatchObject({ state: changed ? 'saved' : 'unchanged', baseline: { commitSha: SAVED, files: { 'src/main.ts': blob(f.local['src/main.ts'] as string) } } });
  expect(f.calls.filter(c => c.method === 'PATCH')).toHaveLength(changed ? 1 : 0);
});

it('forbids every ref write when durable prepare fails', async () => {
  const f = fixture();
  f.options.preparePublication = async () => { throw new Error('database unavailable'); };
  expect((await checkpointRequirementWorkspace(f.options)).state).toBe('failed');
  expect(f.calls.filter(c => c.method === 'PATCH' || (c.path === '/git/refs' && c.method === 'POST'))).toHaveLength(0);
});

it('requires a host publication journal before any GitHub mutation', async () => {
  const f = fixture();
  delete f.options.preparePublication;
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'skipped', reason: 'publication_journal_required' });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('discards a definitely unapplied create intent and prepares a fresh branch publication', async () => {
  const f = fixture();
  const first = await checkpointRequirementWorkspace(f.options);
  const pending: RequirementCheckpointPublicationIntent = { baseline: first.baseline!, parentSha: HEAD, expectedSha: SAVED, createRef: true };
  const normal = f.mock.getMockImplementation()!;
  let created = false;
  f.mock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: HEAD } }));
    if (url.includes('/git/ref/heads/') && !created) return new Response('{}', { status: 404 });
    if (url.endsWith('/git/refs') && init?.method === 'POST') {
      expect(f.options.preparePublication).toHaveBeenLastCalledWith(expect.objectContaining({ createRef: true, parentSha: HEAD, expectedSha: SAVED }));
      created = true; return new Response('{}');
    }
    return normal(input, init);
  });
  expect(await checkpointRequirementWorkspace({ ...f.options, pendingPublication: pending })).toMatchObject({ state: 'saved', baseline: { commitSha: SAVED } });
});

it('rejects a pending intent whose expected SHA does not match its receipt before reading HEAD', async () => {
  const f = fixture();
  const first = await checkpointRequirementWorkspace(f.options);
  (f.workspace.exec as jest.Mock).mockClear(); f.calls.length = 0;
  expect(await checkpointRequirementWorkspace({ ...f.options, pendingPublication: {
    baseline: first.baseline!, parentSha: HEAD, expectedSha: REMOTE, createRef: false,
  } })).toMatchObject({ state: 'skipped', reason: 'pending_publication_invalid' });
  expect(f.workspace.exec).not.toHaveBeenCalled();
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it.each(['descendant', 'diverged', 'foreign', 'not-applied', 'absent'])('reconciles pending intent conservatively: %s', async mode => {
  const f = fixture();
  const saved = await checkpointRequirementWorkspace(f.options);
  const pending: RequirementCheckpointPublicationIntent = { baseline: saved.baseline!, parentSha: HEAD, expectedSha: SAVED, createRef: false };
  const normal = f.mock.getMockImplementation()!;
  f.calls.length = 0; (f.workspace.exec as jest.Mock).mockClear();
  f.remote(mode === 'not-applied' ? HEAD : REMOTE, [entry('src/main.ts', f.local['src/main.ts'] as string)]);
  if (mode === 'foreign') pending.baseline = { ...pending.baseline, workspaceId: randomUUID() };
  f.mock.mockImplementation(async (input, init) => {
    if (mode === 'absent' && String(input).includes('/git/ref/')) return new Response('{}', { status: 404 });
    if (mode === 'diverged' && String(input).includes('/compare/')) return new Response(JSON.stringify({ status: 'diverged', merge_base_commit: { sha: HEAD } }));
    return normal(input, init);
  });
  const result = await checkpointRequirementWorkspace({ ...f.options, pendingPublication: pending });
  expect(result.state).toBe(mode === 'descendant' ? 'unchanged' : mode === 'not-applied' ? 'saved' : 'skipped');
  if (['foreign', 'diverged', 'absent'].includes(mode)) {
    expect(f.workspace.exec).not.toHaveBeenCalled();
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
  }
});

it.each(['safe', 'conflict', 'unpublished', 'rewrite'])('allows only GitHub-verified descendant HEAD advances with per-path three-way merge: %s', async mode => {
  const old = 'export const value = 1;';
  const remoteOnly = 'export const value = 8;';
  const f = fixture({ 'src/main.ts': old, 'remote-only.ts': old }, [entry('src/main.ts', old), entry('remote-only.ts', old)]);
  f.remote(REMOTE, [entry('src/main.ts', old), entry('remote-only.ts', remoteOnly)]);
  const first = await checkpointRequirementWorkspace(f.options);
  expect(first.state).toBe('unchanged');
  const nextHead = hash('verified new HEAD');
  const newest = hash('newest remote');
  const newHeadTree = [entry('src/main.ts', 'export const value = 2;'), entry('remote-only.ts', old)];
  f.local['src/main.ts'] = 'export const value = 3;';
  f.remote(newest, [entry('src/main.ts', mode === 'conflict' ? 'export const value = 5;' : 'export const value = 2;'), entry('remote-only.ts', remoteOnly)]);
  const normalExec = (f.workspace.exec as jest.Mock).getMockImplementation()!;
  (f.workspace.exec as jest.Mock).mockImplementation(async (input, signal) => input.command.includes('rev-parse')
    ? { exitCode: 0, stdout: nextHead + '\n', stderr: '' } : normalExec(input, signal));
  const normal = f.mock.getMockImplementation()!;
  f.mock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (mode === 'unpublished' && url.includes(`/compare/${nextHead}...`)) return new Response('{}', { status: 404 });
    if (mode === 'rewrite' && url.includes(`/compare/${HEAD}...${nextHead}`)) return new Response(JSON.stringify({ status: 'diverged' }));
    if (url.endsWith(`/git/commits/${nextHead}`)) return new Response(JSON.stringify({ sha: nextHead, tree: { sha: hash('new HEAD tree') } }));
    if (url.includes(`/git/trees/${hash('new HEAD tree')}`)) return new Response(JSON.stringify({ truncated: false, tree: newHeadTree }));
    if (url.endsWith(`/git/commits/${REMOTE}`)) return new Response(JSON.stringify({ sha: REMOTE, tree: { sha: hash('old remote tree') } }));
    if (url.includes(`/git/trees/${hash('old remote tree')}`)) return new Response(JSON.stringify({ truncated: false, tree: [entry('src/main.ts', old), entry('remote-only.ts', remoteOnly)] }));
    return normal(input, init);
  });
  f.calls.length = 0;
  const result = await checkpointRequirementWorkspace({ ...f.options, baseline: first.baseline });
  expect(result.state).toBe(mode === 'safe' ? 'saved' : 'skipped');
  if (mode === 'safe') {
    expect(f.calls.find(c => c.path === '/git/trees')!.body.tree).toEqual([{ path: 'src/main.ts', type: 'blob', mode: '100644', content: f.local['src/main.ts'] }]);
    expect(result.baseline).toMatchObject({ headSha: nextHead, files: { 'remote-only.ts': blob(old) } });
  } else expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('rejects baseline from another workspace instead of rebasing silently', async () => {
  const f = fixture();
  const first = await checkpointRequirementWorkspace(f.options);
  expect(await checkpointRequirementWorkspace({ ...f.options, baseline: { ...first.baseline!, workspaceId: randomUUID() } })).toMatchObject({ state: 'skipped', reason: 'baseline_identity_mismatch' });
});

it('withholds every write on conflicting remote/local edits', async () => {
  const f = fixture();
  f.remote(REMOTE, [entry('src/main.ts', 'export const value = 3;')]);
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'skipped', reason: 'remote_workspace_conflict' });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('does not mistake unchanged stale workspace content for a revert across host-baseline cycles', async () => {
  const f = fixture({ 'src/main.ts': 'export const value = 1;' });
  f.remote(REMOTE, [entry('src/main.ts', 'export const value = 3;')]);
  const first = await checkpointRequirementWorkspace(f.options);
  expect(first.state).toBe('unchanged');
  const second = await checkpointRequirementWorkspace({ ...f.options, baseline: first.baseline });
  expect(second.state).toBe('unchanged');
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
  f.local['src/main.ts'] = 'export const value = 4;';
  const third = await checkpointRequirementWorkspace({ ...f.options, baseline: second.baseline });
  // Baseline remote had already advanced separately: new local edit must not overwrite it.
  expect(third.state).toBe('skipped');
});

it.each(['node_modules/pkg/a.ts', '.env.local', '.github/workflows/run.yml', '.gitmodules', 'hooks/pre-commit', '../outside.ts', '/absolute.ts', 'a/.ssh/key', '.git/config'])('never reads excluded name %s', async path => {
  const f = fixture({ [path]: 'not exported' }, []);
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'unchanged', excludedCount: 1 });
  expect(f.workspace.readFile).not.toHaveBeenCalled();
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('excludes credentials, redacted values, binaries, symlinks and submodules', async () => {
  const secret = randomBytes(24).toString('hex');
  const f = fixture({ 'config.json': JSON.stringify({ password: secret }), 'src/key.ts': `export const credential = "${secret}";`,
    'binary.txt': 'bad\0data', 'redacted.txt': '[REDACTED]', 'link.txt': new WorkspaceError('PATH_DENIED', 'denied'),
    'sub/a.ts': 'export const value = 5;', sub: new WorkspaceError('PATH_DENIED', 'denied'), 'safe.ts': 'export const safe = true;' }, [entry('sub', '', '160000', 'commit'), entry('link.txt', 'target', '120000')]);
  const result = await checkpointRequirementWorkspace(f.options);
  expect(result).toMatchObject({ state: 'saved', excludedCount: 7 });
  const changes = f.calls.find(c => c.path === '/git/trees')!.body.tree;
  expect(changes.map((c: any) => c.path)).toEqual(['safe.ts']);
  expect(JSON.stringify(changes)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('deletes only absent safe tracked regular content with matching remote and index proof', async () => {
  const f = fixture({ 'src/main.ts': new WorkspaceError('FILE_NOT_FOUND', 'absent') });
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'saved' });
  expect(f.calls.find(c => c.path === '/git/trees')!.body.tree).toEqual([{ path: 'src/main.ts', mode: '100644', type: 'blob', sha: null }]);
});

it('never interprets an unlisted staged removal or failed read as deletion', async () => {
  const f = fixture({});
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'unchanged', excludedCount: 1 });
  f.local['src/main.ts'] = new WorkspaceError('PATH_DENIED', 'denied');
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'unchanged', excludedCount: 1 });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('does not delete skip-worktree / assume-unchanged missing paths', async () => {
  const f = fixture({ 'src/main.ts': new WorkspaceError('FILE_NOT_FOUND', 'absent') });
  const exec = f.workspace.exec as jest.Mock;
  const normal = exec.getMockImplementation()!;
  exec.mockImplementation(async (input, signal) => input.command.includes('"-v"')
    ? listingOutput(input.command, 'S src/main.ts\0') : normal(input, signal));
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'unchanged', excludedCount: 1 });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('always filters the passed Git credential even with an identity caller redactor', async () => {
  const f = fixture(); f.options.redact = text => text;
  f.local['accidental.txt'] = f.token;
  const result = await checkpointRequirementWorkspace(f.options);
  expect(result).toMatchObject({ state: 'saved', excludedCount: 1 });
  expect(JSON.stringify(f.calls.map(c => c.body))).not.toContain(f.token);
  expect(JSON.stringify(result)).not.toContain(f.token);
});

it.each(['lost-ack', 'nonfastforward', 'unverifiable'])('handles ref update outcome: %s without force or write retries', async mode => {
  const f = fixture();
  const normal = f.mock.getMockImplementation()!;
  let patched = false;
  f.mock.mockImplementation(async (input, init) => {
    if (init?.method === 'PATCH') {
      patched = true;
      if (mode === 'nonfastforward') return new Response('{}', { status: 422 });
      if (mode === 'lost-ack') await normal(input, init);
      throw new Error(f.token);
    }
    if (patched && mode === 'unverifiable') throw new Error(f.token);
    return normal(input, init);
  });
  const result = await checkpointRequirementWorkspace(f.options);
  expect(result.state).toBe(mode === 'lost-ack' ? 'saved' : mode === 'nonfastforward' ? 'skipped' : 'unknown');
  expect(f.mock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(f.token);
});

it('asserts ownership immediately before every workspace and HTTP boundary', async () => {
  const f = fixture();
  let permit = false;
  f.options.assertActive = jest.fn(async () => { permit = true; });
  const take = () => { expect(permit).toBe(true); permit = false; };
  const normal = f.mock.getMockImplementation()!;
  f.mock.mockImplementation(async (...args) => { take(); return normal(...args); });
  for (const method of ['exec', 'readFile'] as const) {
    const fn = f.workspace[method] as jest.Mock;
    const impl = fn.getMockImplementation()!;
    fn.mockImplementation(async (...args) => { take(); return impl(...args); });
  }
  expect((await checkpointRequirementWorkspace(f.options)).state).toBe('saved');
});

it('fences cancellation and does not leak raw SDK or URL credentials', async () => {
  const f = fixture();
  const credentialUrl = new URL('https://example.invalid/private');
  credentialUrl.username = f.username; credentialUrl.password = f.token;
  f.options.assertActive = async () => { throw new Error(credentialUrl.href); };
  const result = await checkpointRequirementWorkspace(f.options);
  expect(result.state).toBe('failed');
  expect(f.mock).not.toHaveBeenCalled();
  expect(f.workspace.exec).not.toHaveBeenCalled();
  for (const value of [f.username, f.token, credentialUrl.href]) expect(JSON.stringify(result)).not.toContain(value);
});

it.each(['disabled', 'invalid-repository', 'wrong-branch', 'aborted'])('skips inadmissible checkpoint %s without IO', async mode => {
  const f = fixture();
  if (mode === 'disabled') f.options.git!.allowPush = false;
  if (mode === 'invalid-repository') f.options.repositoryUrl = 'https://example.invalid/org/repo';
  if (mode === 'wrong-branch') f.options.branch = 'main';
  if (mode === 'aborted') f.options.signal = AbortSignal.abort();
  expect((await checkpointRequirementWorkspace(f.options)).state).toBe('skipped');
  expect(f.mock).not.toHaveBeenCalled(); expect(f.workspace.exec).not.toHaveBeenCalled();
});

it('rejects untrusted/unpushed local HEAD ancestry and truncated remote trees before writes', async () => {
  const f = fixture(); f.remote(REMOTE, f.base);
  const normal = f.mock.getMockImplementation()!;
  f.mock.mockImplementation(async (input, init) => String(input).includes('/compare/')
    ? new Response(JSON.stringify({ status: 'diverged', merge_base_commit: { sha: hash('other') } })) : normal(input, init));
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'skipped', reason: 'baseline_not_remote_ancestor' });
  f.mock.mockImplementation(async (input, init) => String(input).includes('/git/trees/')
    ? new Response(JSON.stringify({ truncated: true, tree: [] })) : normal(input, init));
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'skipped', reason: 'remote_tree_limit' });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('bounds capture paths and tree updates without publishing a partial checkpoint', async () => {
  const f = fixture(Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`src/${n}.ts`, 'export const value = 1;'])), []);
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'skipped', reason: 'checkpoint_update_limit' });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('rejects inconsistent paginated enumerations rather than checkpointing a partial capture', async () => {
  const f = fixture(Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [`src/file-with-a-long-realistic-name-${n}.ts`, 'export const value = 1;'])), []);
  const normal = (f.workspace.exec as jest.Mock).getMockImplementation()!;
  (f.workspace.exec as jest.Mock).mockImplementation(async (input, signal) => {
    const output = await normal(input, signal);
    if (input.command.includes('"offset":32768')) {
      const page = JSON.parse(output.stdout); page.digest = '0'.repeat(64);
      return { ...output, stdout: JSON.stringify(page) };
    }
    return output;
  });
  expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'skipped', reason: 'workspace_capture_incomplete' });
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it('does not read unchanged tracked files; remote HEAD supplies their baseline hashes', async () => {
  const f = fixture({ 'src/main.ts': 'export const value = 1;' });
  const exec = f.workspace.exec as jest.Mock;
  const normal = exec.getMockImplementation()!;
  exec.mockImplementation(async (input, signal) => input.command.includes('"changed":true')
    ? listingOutput(input.command, '') : normal(input, signal));
  const result = await checkpointRequirementWorkspace(f.options);
  expect(result).toMatchObject({ state: 'unchanged', baseline: { files: { 'src/main.ts': blob('export const value = 1;') } } });
  expect(f.workspace.readFile).not.toHaveBeenCalled();
});

it('reads a revert to local HEAD despite clean stat hints after an earlier checkpoint', async () => {
  const f = fixture();
  const first = await checkpointRequirementWorkspace(f.options);
  f.remote(SAVED, [entry('src/main.ts', f.local['src/main.ts'] as string)]);
  f.local['src/main.ts'] = 'export const value = 1;';
  const exec = f.workspace.exec as jest.Mock;
  const normal = exec.getMockImplementation()!;
  exec.mockImplementation(async (input, signal) => input.command.includes('"changed":true')
    ? listingOutput(input.command, '') : normal(input, signal));
  const second = await checkpointRequirementWorkspace({ ...f.options, baseline: first.baseline });
  expect(second.state).toBe('saved');
  expect(f.calls.filter(c => c.path === '/git/trees').at(-1)!.body.tree).toEqual([
    { path: 'src/main.ts', mode: '100644', type: 'blob', content: 'export const value = 1;' },
  ]);
});

it('reads staged changes even when stat enumeration reports a clean index', async () => {
  const f = fixture();
  const exec = f.workspace.exec as jest.Mock;
  const normal = exec.getMockImplementation()!;
  exec.mockImplementation(async (input, signal) => input.command.includes('"changed":true')
    ? listingOutput(input.command, '') : input.command.includes('--stage')
      ? listingOutput(input.command, `100644 ${blob(f.local['src/main.ts'] as string)} 0\tsrc/main.ts\0`)
      : normal(input, signal));
  expect((await checkpointRequirementWorkspace(f.options)).state).toBe('saved');
  expect(f.workspace.readFile).toHaveBeenCalledWith('src/main.ts', f.options.signal);
});

it('captures a real 1001-file repository with >64KiB index enumeration, never staged bytes/history or local mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-offline-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: dir, env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });
  try {
    git('init', '-q'); git('checkout', '-b', branch);
    mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src/main.ts'), 'export const value = 1;');
    const unchanged = Array.from({ length: 1000 }, (_, n) => entry(`src/unchanged-file-with-realistic-long-name-${n}.ts`, `export const value = ${n};`));
    for (let n = 0; n < unchanged.length; n++) writeFileSync(join(dir, unchanged[n].path), `export const value = ${n};`);
    git('add', 'src'); git('-c', 'user.name=Offline', '-c', 'user.email=offline@example.invalid', 'commit', '-qm', 'fixture');
    expect(Buffer.byteLength(git('ls-files', '--stage', '-z'))).toBeGreaterThan(64 * 1024);
    const realHead = git('rev-parse', 'HEAD').trim();
    const f = fixture();
    f.base.push(...unchanged);
    const stagedSecret = randomBytes(32).toString('hex');
    writeFileSync(join(dir, 'src/main.ts'), `export const credential = "${stagedSecret}";`); git('add', 'src/main.ts');
    writeFileSync(join(dir, 'src/main.ts'), 'export const value = 2;');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(dir, 'ignored.txt'), stagedSecret);
    symlinkSync('src/main.ts', join(dir, 'link.ts'));
    const beforeIndex = readFileSync(join(dir, '.git/index'));
    const beforeStatus = git('status', '--porcelain');
    // Git ls-files --modified would execute this hostile clean filter. The
    // checkpoint must use raw no-follow hashing rather than Git diff machinery.
    writeFileSync(join(dir, '.gitattributes'), '*.ts filter=sentinel\n');
    git('config', 'filter.sentinel.clean', 'touch filter-executed; cat');
    git('config', 'core.fsmonitor', 'touch fsmonitor-executed');
    git('config', 'core.hooksPath', '.git/hostile-hooks');
    mkdirSync(join(dir, '.git/hostile-hooks'));
    writeFileSync(join(dir, '.git/hostile-hooks/pre-commit'), '#!/bin/sh\ntouch hook-executed\n', { mode: 0o755 });
    // HTTP baseline fixture uses a synthetic remote HEAD; map only its identity, not local tree/content.
    f.workspace.exec = jest.fn(async ({ command }) => {
      let stdout = execFileSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
      if (command.includes('rev-parse')) { expect(stdout.trim()).toBe(realHead); stdout = HEAD + '\n'; }
      expect(Buffer.byteLength(stdout)).toBeLessThan(64 * 1024);
      return { stdout, stderr: '', exitCode: 0, truncated: false };
    });
    f.workspace.readFile = jest.fn(async path => {
      const full = join(dir, path);
      if (lstatSync(full).isSymbolicLink()) throw new WorkspaceError('PATH_DENIED', 'denied');
      return readFileSync(full, 'utf8');
    });
    expect(await checkpointRequirementWorkspace(f.options)).toMatchObject({ state: 'saved' });
    const changes = f.calls.find(c => c.path === '/git/trees')!.body.tree;
    expect(changes).toEqual([{ path: 'src/main.ts', mode: '100644', type: 'blob', content: 'export const value = 2;' }]);
    expect(JSON.stringify(changes)).not.toContain(stagedSecret);
    expect(f.workspace.readFile).not.toHaveBeenCalledWith(unchanged[0].path, f.options.signal);
    // Clean paths do not perform one ownership DB round trip per file.
    expect((f.options.assertActive as jest.Mock).mock.calls.length).toBeLessThan(60);
    expect((f.workspace.exec as jest.Mock).mock.calls.some(([input]) => input.command.includes('"offset":65536'))).toBe(true);
    expect(readFileSync(join(dir, '.git/index')).equals(beforeIndex)).toBe(true);
    for (const sentinel of ['filter-executed', 'fsmonitor-executed', 'hook-executed']) expect(existsSync(join(dir, sentinel))).toBe(false);
    rmSync(join(dir, '.gitattributes'));
    git('config', '--unset', 'filter.sentinel.clean');
    git('config', '--unset', 'core.fsmonitor');
    expect(git('status', '--porcelain')).toBe(beforeStatus);
    expect(git('rev-parse', 'HEAD').trim()).toBe(realHead);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});