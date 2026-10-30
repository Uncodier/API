import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCloudFileTools } from '../tools';
import { CloudGitError } from '../git';
import { CloudFileStoreError, type CloudRevision, type CloudScope } from '../types';
import { assertToolScreenAccess, ToolScreenAccessDenied, ToolScreenAccessUnavailable } from '@/app/api/agents/tools/router/screen-access';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: () => { throw new Error('Unexpected database access'); },
} }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'), assertToolScreenAccess: jest.fn(),
}));
jest.mock('@vercel/sandbox', () => { throw new Error('Cloud tools must not import sandbox'); });
jest.mock('@/lib/harness/workspace', () => { throw new Error('Cloud tools must not import workspace'); });
jest.mock('@/app/api/robots/instance/assistant/workspace-provider', () => { throw new Error('Cloud tools must not provision workspace'); });

function fixture(requirementId?: string) {
  const scope: CloudScope = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    ...(requirementId ? { requirementId } : {}) };
  const content = '# Private cloud document\nRésumé';
  const revision: CloudRevision = { file_id: randomUUID(), version: 1, name: 'notes.md', mime: 'text/markdown',
    content, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content),
    requirement_id: requirementId ?? null, instance_id: scope.instanceId, git_status: 'pending' };
  const store = {
    readOperation: jest.fn().mockResolvedValue(null),
    read: jest.fn().mockResolvedValue(revision),
    list: jest.fn().mockResolvedValue({ files: [revision], next_offset: null }),
    write: jest.fn().mockResolvedValue({ ...revision, state: 'created' }),
    listPendingGit: jest.fn(), setGitResult: jest.fn(), bindGitTarget: jest.fn().mockResolvedValue(revision),
  };
  const publish = jest.fn().mockResolvedValue({ ...revision, git_status: 'committed', git_commit_sha: 'a'.repeat(40) });
  const operationId = jest.fn(() => randomUUID());
  const assertActive = jest.fn().mockResolvedValue(undefined);
  const tools = createCloudFileTools(scope, assertActive, { store, publish, operationId });
  const call = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute(args);
  return { scope, revision, store, publish, assertActive, operationId, tools, call };
}
beforeEach(() => { jest.clearAllMocks(); jest.mocked(assertToolScreenAccess).mockResolvedValue(undefined); });

it('keeps saved bytes and reports an actionable empty-repository Git blocker', async () => {
  const f = fixture();
  f.publish.mockRejectedValue(new CloudGitError('repository_uninitialized'));
  const result = await f.call('write_cloud_file', { action: 'create', name: f.revision.name, content: f.revision.content });
  expect(result).toMatchObject({ ok: true, output: { saved: true, git_status: 'pending', git_blocker: 'repository_uninitialized',
    git_next_action: expect.stringContaining('initial commit') } });
  expect(f.store.write).toHaveBeenCalledTimes(1);
});

it('reports storage quota denial as a definite no-write failure without Git dispatch', async () => {
  const f = fixture();
  f.store.write.mockRejectedValue(new CloudFileStoreError('quota_exceeded'));
  expect(await f.call('write_cloud_file', { action: 'create', name: 'note.md', content: 'text' }))
    .toMatchObject({ ok: false, error: { code: 'quota_exceeded', effectStarted: false } });
  expect(f.publish).not.toHaveBeenCalled();
});

it('exposes lazy private schemas without actor, operation, sandbox or deployment fields', () => {
  const f = fixture();
  expect(f.tools.map(tool => tool.name)).toEqual(['read_cloud_file', 'list_cloud_files', 'write_cloud_file']);
  expect(f.assertActive).not.toHaveBeenCalled();
  expect(assertToolScreenAccess).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  const schema = JSON.stringify(f.tools.map(tool => tool.parameters));
  for (const field of ['site_id', 'user_id', 'instance_id', 'operation_id', 'sandbox_id']) expect(schema).not.toContain(`"${field}"`);
  expect(schema).toContain('262144');
  const source = readFileSync(resolve(process.cwd(), 'src/lib/cloud-files/tools.ts'), 'utf8');
  expect(source).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:sandbox|workspace|child_process)/);
});

it('saves exact revision and returns only authenticated relative versioned receipts', async () => {
  const f = fixture();
  const args = { action: 'create', name: f.revision.name, mime: f.revision.mime, content: f.revision.content };
  const result = await f.call('write_cloud_file', args);
  expect(result.ok).toBe(true);
  expect(result.output).toEqual({ state: 'created', saved: true, file_id: f.revision.file_id, version: 1,
    name: 'notes.md', mime: 'text/markdown', bytes: f.revision.bytes, sha256: f.revision.sha256,
    requirement_id: null, instance_id: f.scope.instanceId, git_status: 'committed', git_commit_sha: 'a'.repeat(40),
    git_repository: null, git_ref: null, git_path: null,
    archive_url: `/api/robots/instance/${f.scope.instanceId}/cloud-files/${f.revision.file_id}?version=1&format=zip`,
    download_url: `/api/robots/instance/${f.scope.instanceId}/cloud-files/${f.revision.file_id}?version=1&format=text` });
  expect(f.store.write).toHaveBeenCalledWith(f.scope, { ...args, operation_id: f.operationId.mock.results[0].value });
  expect(f.publish).toHaveBeenCalledWith(f.scope, { ...f.revision, state: 'created' },
    { store: f.store, assertActive: expect.any(Function) });
  expect(assertToolScreenAccess).toHaveBeenCalledWith('write_cloud_file', f.scope);
});

it('reads an exact historical version without publishing or writing', async () => {
  const f = fixture(); f.revision.version = 3;
  const result = await f.call('read_cloud_file', { file_id: f.revision.file_id, version: 3 });
  expect(result).toMatchObject({ ok: true, output: { version: 3, content: f.revision.content } });
  expect(f.store.read).toHaveBeenCalledWith(f.scope, f.revision.file_id, 3);
  expect(f.publish).not.toHaveBeenCalled(); expect(f.store.write).not.toHaveBeenCalled();
  f.store.read.mockResolvedValueOnce(null);
  expect(await f.call('read_cloud_file', { file_id: randomUUID() })).toMatchObject({ ok: false, output: { error: { code: 'not_found' } } });
});

it('forwards name/content search and pagination, defaulting to bound requirement', async () => {
  const f = fixture(randomUUID());
  f.store.list.mockResolvedValue({ files: [f.revision], next_offset: 22 });
  expect(await f.call('list_cloud_files', { query: 'Résumé', offset: 20, limit: 2 })).toMatchObject({
    ok: true, output: { files: [{ file_id: f.revision.file_id }], next_offset: 22 },
  });
  expect(f.store.list).toHaveBeenCalledWith(f.scope,
    { requirement_id: f.scope.requirementId, query: 'Résumé', offset: 20, limit: 2 });
  const standalone = fixture(); const requirement = randomUUID(); standalone.revision.requirement_id = requirement;
  await standalone.call('list_cloud_files', { requirement_id: requirement });
  expect(standalone.store.list).toHaveBeenCalledWith(standalone.scope, { requirement_id: requirement });
});

it('rejects requirement filter override and model-driven standalone attachment before store access', async () => {
  const f = fixture(randomUUID());
  expect(await f.call('list_cloud_files', { requirement_id: randomUUID() })).toMatchObject({ ok: false, output: { error: { code: 'forbidden' } } });
  expect(f.store.list).not.toHaveBeenCalled();
  const standalone = fixture();
  expect(await standalone.call('write_cloud_file', { action: 'create', name: 'a.txt', content: '', requirement_id: randomUUID() }))
    .toMatchObject({ ok: false, output: { error: { code: 'forbidden' } } });
  expect(standalone.store.write).not.toHaveBeenCalled();
});

it('requires host-owned requirement writer permission and stable operation ID', async () => {
  const f = fixture(randomUUID());
  const args = { action: 'create', name: 'a.md', content: '', requirement_id: f.scope.requirementId };
  expect(await f.call('write_cloud_file', args)).toMatchObject({ ok: false, output: { error: { code: 'requirement_owner_required' } } });
  expect(f.store.write).not.toHaveBeenCalled();
  const stableId = randomUUID();
  const write = createCloudFileTools(f.scope, f.assertActive, { store: f.store, publish: f.publish,
    operationId: () => stableId, allowRequirementWrite: true }).find(tool => tool.name === 'write_cloud_file')!;
  await write.execute(args); await write.execute(args);
  expect(f.store.write).toHaveBeenCalledTimes(2);
  for (const [scope, input] of f.store.write.mock.calls) {
    expect(scope.requirementId).toBe(f.scope.requirementId);
    expect(input.operation_id).toBe(stableId); expect(input).not.toHaveProperty('requirement_id');
  }
});

it.each(['replace', 'patch'])('forwards optimistic %s edits and preserves conflict without publishing', async action => {
  const f = fixture();
  const args = { action, file_id: f.revision.file_id, expected_version: 1,
    ...(action === 'replace' ? { content: 'updated' } : { changes: [{ old_text: 'Résumé', new_text: 'Summary' }] }) };
  f.store.write.mockResolvedValue({ ...f.revision, version: 2, state: 'conflict' });
  expect(await f.call('write_cloud_file', args)).toMatchObject({ ok: false, output: { state: 'conflict', version: 2 } });
  expect(f.store.write).toHaveBeenCalledWith(f.scope, { ...args, operation_id: expect.any(String) });
  expect(f.publish).not.toHaveBeenCalled();
});

it('preserves unchanged committed receipts without republishing', async () => {
  const f = fixture();
  f.store.write.mockResolvedValue({ ...f.revision, state: 'unchanged', git_status: 'committed', git_commit_sha: 'b'.repeat(40) });
  expect(await f.call('write_cloud_file', { action: 'replace', file_id: f.revision.file_id, expected_version: 1, content: f.revision.content }))
    .toMatchObject({ ok: true, output: { state: 'unchanged', version: 1, git_status: 'committed' } });
  expect(f.publish).not.toHaveBeenCalled();
});

it.each(['site_id', 'user_id', 'instance_id', 'siteId', 'userId', 'instanceId', 'operation_id', 'allowRequirementWrite'])('rejects untrusted %s authority', async field => {
  const f = fixture();
  expect(await f.call('write_cloud_file', { action: 'create', name: 'a.txt', content: '', [field]: randomUUID() }))
    .toMatchObject({ ok: false, output: { error: { code: 'invalid_input' } } });
  expect(f.store.write).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
});

it.each([
  { name: '../x' }, { name: '.git' }, { name: 'a/b.txt' }, { name: 'a\\b.txt' }, { name: 'CON.txt' },
  { name: 'a.txt.' }, { mime: 'application/octet-stream' }, { content: 'é'.repeat(131073) },
  { content: '\ud800' }, { content: '\0' }, { action: 'replace' }, { expected_version: 1 },
  { changes: [{ old_text: '', new_text: 'x' }] },
])('rejects invalid write shape or unsafe text/name/MIME %#', async overrides => {
  const f = fixture();
  expect(await f.call('write_cloud_file', { action: 'create', name: 'a.txt', content: '', ...overrides }))
    .toMatchObject({ ok: false, output: { error: { code: 'invalid_input' } } });
  expect(f.store.write).not.toHaveBeenCalled();
});

it.each([new ToolScreenAccessDenied(), new ToolScreenAccessUnavailable()])('does not touch store when permissions fail', async error => {
  const f = fixture(); jest.mocked(assertToolScreenAccess).mockRejectedValue(error);
  for (const tool of f.tools) expect((await tool.execute({})).ok).toBe(false);
  for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it('fences execution and snapshots actor scope', async () => {
  const f = fixture(); const original = { ...f.scope }; f.scope.userId = randomUUID();
  await f.call('list_cloud_files', {}); expect(f.store.list).toHaveBeenCalledWith(original, {});
  f.store.list.mockClear(); f.assertActive.mockRejectedValue(new Error('owner changed'));
  expect(await f.call('list_cloud_files', {})).toMatchObject({ ok: false, output: { error: { code: 'inactive' } } });
  expect(f.store.list).not.toHaveBeenCalled();
});

it('maps fixed store errors and never leaks synthetic provider credentials or authenticated URLs', async () => {
  const f = fixture();
  const username = randomBytes(20).toString('hex'), password = randomBytes(24).toString('hex'), token = randomBytes(32).toString('hex');
  const url = new URL('https://provider.example.test/document'); url.username = username; url.password = password;
  const secretError = new Error(`${url} ${token}`);
  f.store.read.mockRejectedValue(secretError);
  const failedRead = await f.call('read_cloud_file', { file_id: f.revision.file_id });
  expect(failedRead).toMatchObject({ ok: false, output: { error: { code: 'unavailable' } } });
  f.publish.mockRejectedValue(secretError);
  const saved = await f.call('write_cloud_file', { action: 'create', name: 'a.txt', content: '' });
  expect(saved).toMatchObject({ ok: true, output: { state: 'created', version: 1, git_status: 'pending', git_commit_sha: null } });
  for (const sensitive of [username, password, token, url.toString()]) {
    expect(JSON.stringify(failedRead)).not.toContain(sensitive);
    expect(JSON.stringify(saved)).not.toContain(sensitive);
  }
  f.store.write.mockRejectedValue(new CloudFileStoreError('patch_conflict'));
  expect(await f.call('write_cloud_file', { action: 'patch', file_id: f.revision.file_id, expected_version: 1,
    changes: [{ old_text: 'not present', new_text: '' }] })).toMatchObject({ ok: false, output: { error: { code: 'patch_conflict' } } });
});

it('returns saved state even if ownership expires before Git publication', async () => {
  const f = fixture();
  f.store.write.mockImplementation(async () => {
    f.assertActive.mockRejectedValue(new Error('cancelled'));
    return { ...f.revision, state: 'created' };
  });
  expect(await f.call('write_cloud_file', { action: 'create', name: 'a.txt', content: '' }))
    .toMatchObject({ ok: true, output: { state: 'created', git_status: 'pending' } });
  expect(f.publish).not.toHaveBeenCalled();
});

it('paginates large escaped content within durable receipt budget without dropping characters', async () => {
  const f = fixture(); f.revision.content = '\t\n😀Résumé'.repeat(1500);
  let offset = 0, collected = '';
  do {
    const result = await f.call('read_cloud_file', { file_id: f.revision.file_id, version: 1, offset, max_chars: 8000 });
    expect(result.ok).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12000);
    expect(result.output.total_chars).toBe(f.revision.content.length);
    collected += result.output.content;
    if (result.output.next_offset === null) break;
    expect(result.output.next_offset).toBeGreaterThan(offset);
    offset = result.output.next_offset as number;
  } while (offset < f.revision.content.length);
  expect(collected).toBe(f.revision.content);
});

it('caps list receipts to durable budget with continuation instead of silent truncation', async () => {
  const f = fixture();
  const files = Array.from({ length: 100 }, () => ({ ...f.revision, file_id: randomUUID() }));
  f.store.list.mockResolvedValue({ files, next_offset: null });
  const result = await f.call('list_cloud_files', { offset: 3, limit: 100 });
  expect(result.ok).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12000);
  expect((result.output.files as unknown[]).length).toBeLessThan(100);
  expect(result.output.next_offset).toBe(3 + (result.output.files as unknown[]).length);
  expect(JSON.stringify(result)).not.toContain(f.revision.content);
});

it('keeps Unicode pairs intact even with one-character pages and rejects split offsets', async () => {
  const f = fixture(); f.revision.content = 'A😀B';
  const first = await f.call('read_cloud_file', { file_id: f.revision.file_id, max_chars: 2 });
  expect(first.output.content).toBe('A'); expect(first.output.next_offset).toBe(1);
  const second = await f.call('read_cloud_file', { file_id: f.revision.file_id, offset: 1, max_chars: 1 });
  expect(second.output.content).toBe('😀'); expect(second.output.next_offset).toBe(3);
  expect(await f.call('read_cloud_file', { file_id: f.revision.file_id, offset: 2 }))
    .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});

it('includes the exact persisted private Git target in delivery receipts', async () => {
  const f = fixture();
  const target = { git_repository: 'offline/documents', git_ref: `refs/heads/cloud-files/${'c'.repeat(64)}/v1`, git_path: 'notes.md' };
  f.publish.mockResolvedValue({ ...f.revision, ...target, git_status: 'committed', git_commit_sha: 'd'.repeat(40) });
  expect(await f.call('write_cloud_file', { action: 'create', name: 'notes.md', content: f.revision.content }))
    .toMatchObject({ ok: true, output: { ...target, git_commit_sha: 'd'.repeat(40), version: 1, sha256: f.revision.sha256 } });
});

it('refreshes publisher failure status from the exact saved version without losing save acknowledgement', async () => {
  const f = fixture();
  f.publish.mockRejectedValue(new Error('Provider failed'));
  f.store.read.mockResolvedValue({ ...f.revision, git_status: 'failed', git_repository: 'offline/docs',
    git_ref: `refs/heads/cloud-files/${'e'.repeat(64)}/v1`, git_path: 'notes.md' });
  const result = await f.call('write_cloud_file', { action: 'create', name: 'notes.md', content: f.revision.content });
  expect(result).toMatchObject({ ok: true, output: { saved: true, git_status: 'failed', git_repository: 'offline/docs' } });
  expect(f.store.read).toHaveBeenCalledWith(f.scope, f.revision.file_id, 1);
});

it('only marks definite no-effect errors safe for durable replay', async () => {
  const f = fixture();
  f.store.write.mockRejectedValueOnce(new CloudFileStoreError('unavailable'));
  const args = { action: 'create', name: 'a.txt', content: '' };
  expect((await f.call('write_cloud_file', args)).error).not.toHaveProperty('effectStarted');
  f.store.write.mockRejectedValueOnce(new CloudFileStoreError('operation_mismatch'));
  expect((await f.call('write_cloud_file', args)).error).toMatchObject({ effectStarted: false });
  f.store.write.mockResolvedValueOnce({ ...f.revision, state: 'conflict' });
  expect((await f.call('write_cloud_file', args)).error).toMatchObject({ code: 'conflict', effectStarted: false });
});