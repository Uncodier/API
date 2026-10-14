import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import type { HarnessTool, ToolContext, Workspace } from '../types';
import { createWorkspaceTools } from '../workspace-tools';
import { WORKSPACE_FILE_PROGRAM, WORKSPACE_ROOT, openWorkspace } from '../workspace';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));

/** Only this trusted helper is executed locally; no repository scripts, network or host env. */
function localHelper(root: string, input: Record<string, unknown>) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', WORKSPACE_FILE_PROGRAM, JSON.stringify({ ...input, root })],
    { env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Offline file helper exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('real descriptor-relative file helper, offline temporary filesystem', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'workspace-file-test-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  test('creates/reads UTF-8 files, including quotes without shell interpolation', () => {
    const path = "src/a'quote.txt";
    expect(localHelper(root, { op: 'write', path, content: 'héllo\nworld' })).toMatchObject({ ok: true });
    expect(localHelper(root, { op: 'read', path })).toEqual({ ok: true, content: 'héllo\nworld' });
  });
  test('protects secrets, absolute escape, symlinked parents/files, hardlinks, and canonical root', () => {
    mkdirSync(join(root, 'private'));
    const value = randomBytes(24).toString('hex');
    writeFileSync(join(root, '.env'), value);
    writeFileSync(join(root, 'private', 'key.pem'), value);
    symlinkSync(join(root, '.env'), join(root, 'alias.txt'));
    symlinkSync(join(root, 'private'), join(root, 'linked'));
    linkSync(join(root, '.env'), join(root, 'hard.txt'));
    for (const path of ['.env', 'private/key.pem', '../escape', '/etc/passwd', 'alias.txt', 'linked/anything', 'hard.txt']) {
      const read = localHelper(root, { op: 'read', path });
      expect(read.ok).toBe(false); expect(JSON.stringify(read)).not.toContain(value);
      const write = localHelper(root, { op: 'write', path, content: 'changed' });
      expect(write.ok).toBe(false);
    }
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(value);
    expect(readFileSync(join(root, 'private', 'key.pem'), 'utf8')).toBe(value);
    symlinkSync(root, join(root, 'root-alias'));
    expect(localHelper(join(root, 'root-alias'), { op: 'read', path: 'anything' })).toMatchObject({ ok: false, code: 'PATH_DENIED' });
  });
  test('exact patches require uniqueness, create is exclusive, batch semantics do not overwrite conflicts', () => {
    expect(localHelper(root, { op: 'patch', path: 'a.txt', create: true, content: 'one\none' })).toMatchObject({ ok: true });
    expect(localHelper(root, { op: 'patch', path: 'a.txt', create: true, content: 'overwrite' })).toMatchObject({ ok: false, code: 'PATCH_CONFLICT' });
    expect(localHelper(root, { op: 'patch', path: 'a.txt', oldText: 'one', newText: 'two' })).toMatchObject({ ok: false, code: 'PATCH_CONFLICT' });
    expect(localHelper(root, { op: 'patch', path: 'a.txt', oldText: 'one\none', newText: 'short' })).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('short');
  });
  test('search/list skip secret names, symlinks, dependency folders and binary; search is literal', () => {
    writeFileSync(join(root, 'a.txt'), 'literal .* match\nsecond line');
    writeFileSync(join(root, '.env.local'), 'literal .* hidden');
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 42, 46]));
    mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'x.js'), 'literal .* hidden');
    symlinkSync(join(root, '.env.local'), join(root, 'alias.txt'));
    const result = localHelper(root, { op: 'search', path: '.', query: '.*' });
    expect(result.items).toEqual([{ path: 'a.txt', line: 1, text: 'literal .* match' }]);
    const listing = JSON.stringify(localHelper(root, { op: 'list', path: '.', recursive: true }));
    expect(listing).not.toContain('.env'); expect(listing).not.toContain('alias'); expect(listing).not.toContain('node_modules');
    expect(localHelper(root, { op: 'read', path: 'binary.dat' })).toMatchObject({ ok: false, code: 'BINARY_FILE' });
  });
});

describe('workspace tool contracts and SDK adapter end-to-end offline', () => {
  let root: string;
  let workspace: Workspace;
  let tools: HarnessTool[];
  let context: ToolContext;
  let runCommand: jest.Mock;
  const sessionId = randomUUID();
  const repository = { url: 'https://git.example.invalid/team/repo.git' };
  beforeEach(async () => {
    jest.clearAllMocks();
    root = mkdtempSync(join(realpathSync(tmpdir()), 'workspace-tools-test-'));
    context = { sessionId, operationId: randomUUID(), signal: new AbortController().signal, assertActive: jest.fn().mockResolvedValue(undefined) };
    runCommand = jest.fn(async (input: { args: string[] }) => {
      const marker = input.args.indexOf(WORKSPACE_FILE_PROGRAM);
      const payload = JSON.parse(input.args.slice(marker + 1).join(''));
      if (typeof payload.path === 'string') payload.path = payload.path.replace(WORKSPACE_ROOT, root);
      const result = localHelper(root, payload);
      return { cmdId: 'cmd_offline', exitCode: 0, wait: async () => ({ exitCode: 0 }), kill: jest.fn(),
        logs: () => Object.assign((async function* () { yield { stream: 'stdout', data: JSON.stringify(result) }; })(), { close() {} }) };
    });
    (Sandbox.get as jest.Mock).mockResolvedValue({ name: `h-${sessionId}`, persistent: true, status: 'running',
      tags: { harnessSession: sessionId, harnessRepository: createHash('sha256').update(JSON.stringify([repository.url, null])).digest('hex'), harnessReady: 'true' },
      update: jest.fn().mockResolvedValue(undefined), runCommand, stop: jest.fn().mockResolvedValue({}) });
    workspace = await openWorkspace({ sessionId, repository });
    tools = createWorkspaceTools(workspace);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args, context);

  test('publishes seven JSON-schema tools; unknown/invalid arguments fail as data', async () => {
    expect(tools.map(tool => tool.name)).toEqual(['read_files', 'list_files', 'search', 'apply_patch', 'exec', 'process_status', 'process_stop']);
    for (const tool of tools) expect(tool.parameters.type).toBe('object');
    const result = await call('exec', { command: 'run', timeoutMs: 120001 });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    expect(await call('read_files', { files: [{ path: 'a', startLine: 4, endLine: 1 }] })).toMatchObject({ ok: false });
    expect(await call('exec', { command: 'run', env: { NO: 'not accepted' } })).toMatchObject({ ok: false });
    expect(runCommand).not.toHaveBeenCalled();
  });
  test('creates a framework-agnostic source, exact-patches it, reads ranges and searches', async () => {
    const created = await call('apply_patch', { changes: [{ operation: 'create', path: 'src/main.py', content: 'print("hello")\n# tests later' }] });
    expect(created).toMatchObject({ ok: true, output: { applied: ['src/main.py'], complete: true } });
    expect(await call('apply_patch', { changes: [{ operation: 'replace', path: 'src/main.py', oldText: 'hello', newText: 'world' }] })).toMatchObject({ ok: true });
    expect(await call('read_files', { files: [{ path: 'src/main.py', startLine: 1, endLine: 1 }] })).toMatchObject({ ok: true,
      output: { files: [{ content: 'print("world")', totalLines: 2 }] } });
    expect(await call('search', { query: 'world', path: '.' })).toMatchObject({ ok: true,
      output: { items: [{ path: 'src/main.py', line: 1, text: 'print("world")' }] } });
    expect(await call('list_files', { recursive: true })).toMatchObject({ ok: true,
      output: { items: expect.arrayContaining([{ path: 'src/main.py', type: 'file' }]) } });
  });
  test('partial patch errors carry applied paths with ok:false and definite conflict', async () => {
    const result = await call('apply_patch', { changes: [
      { operation: 'create', path: 'first.txt', content: 'first' },
      { operation: 'replace', path: 'first.txt', oldText: 'missing', newText: 'never' },
      { operation: 'create', path: 'third.txt', content: 'never' },
    ] });
    expect(result).toMatchObject({ ok: false, output: { applied: ['first.txt'], complete: false, failedPath: 'first.txt' }, error: { code: 'PATCH_CONFLICT' } });
    expect(result.error?.ambiguous).toBeUndefined();
    expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe('first');
  });
  test('protects secret paths before any file mutation; symlinks never disclose data', async () => {
    const secret = randomBytes(24).toString('hex');
    writeFileSync(join(root, '.env'), secret); symlinkSync(join(root, '.env'), join(root, 'safe.txt'));
    expect(await call('apply_patch', { changes: [{ operation: 'create', path: 'valid.txt', content: 'first' },
      { operation: 'create', path: '.env', content: 'bad' }] })).toMatchObject({ ok: false, error: { code: 'PATH_DENIED' } });
    expect(runCommand).not.toHaveBeenCalled();
    const read = await call('read_files', { files: [{ path: 'safe.txt' }] });
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(read).toMatchObject({ output: { files: [{ error: { code: 'PATH_DENIED' } }] } });
  });
  test('exec failures are data not gates; uncertain write transport errors are marked ambiguous', async () => {
    jest.spyOn(workspace, 'exec').mockResolvedValue({ stdout: 'failing test', stderr: '', exitCode: 1 });
    const result = await call('exec', { command: 'run-any-language-tests' });
    expect(result).toMatchObject({ ok: false, output: { exitCode: 1, stdout: 'failing test' }, error: { code: 'COMMAND_EXIT_NONZERO' } });
    expect(result.error?.ambiguous).toBeUndefined();
    jest.spyOn(workspace, 'exec').mockRejectedValue(new Error(randomBytes(24).toString('hex')));
    expect(await call('exec', { command: 'touch output.txt' })).toMatchObject({ ok: false, error: { ambiguous: true } });
  });
  test('abort while ownership check awaits dispatches no workspace operation', async () => {
    const controller = new AbortController();
    context.signal = controller.signal;
    context.assertActive = async () => { controller.abort(); };
    const result = await call('exec', { command: 'touch never' });
    expect(result).toMatchObject({ ok: false, error: { effectStarted: false } });
    expect(result.error?.ambiguous).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });
  test('cancel after first patch prevents every subsequent batch dispatch', async () => {
    const controller = new AbortController();
    context.signal = controller.signal;
    const original = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async (...args) => { const result = await original(...args); controller.abort(); return result; });
    expect(await call('apply_patch', { changes: [
      { operation: 'create', path: 'accepted.txt', content: 'accepted before cancel' },
      { operation: 'create', path: 'never.txt', content: 'never' },
    ] })).toMatchObject({ ok: false });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'accepted.txt'), 'utf8')).toBe('accepted before cancel');
  });
  test('owner loss after read stops the multi-file loop, even with a live signal', async () => {
    let active = true;
    context.assertActive = async () => { if (!active) throw new Error('lost owner'); };
    const read = jest.spyOn(workspace, 'readFile').mockImplementation(async () => { active = false; return 'first'; });
    expect(await call('read_files', { files: [{ path: 'first' }, { path: 'never' }] })).toMatchObject({ ok: false });
    expect(read).toHaveBeenCalledTimes(1);
  });
});