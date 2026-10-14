import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import { openWorkspace, WORKSPACE_BOOTSTRAP_PROGRAM } from '../workspace';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));

describe('bootstrap recovery with real offline Git checkout and preserved user data', () => {
  let base: string, root: string, source: string, bin: string;
  const sessionId = randomUUID();
  const repository = { url: 'https://git.example.invalid/team/repo.git', ref: 'main' };
  const hash = createHash('sha256').update(JSON.stringify([repository.url, repository.ref])).digest('hex');
  const cleanEnv = { NODE_ENV: 'test' as const, PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(`Offline Git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const stage = () => join(base, `harness-bootstrap-${sessionId}`);
  function helper() {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', WORKSPACE_BOOTSTRAP_PROGRAM,
      JSON.stringify({ root, stagingParent: base, sessionId, repository: hash, url: repository.url, ref: repository.ref })],
    { env: { ...cleanEnv, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    return result;
  }
  beforeEach(() => {
    jest.resetAllMocks();
    base = mkdtempSync(join(realpathSync(tmpdir()), 'workspace-bootstrap-test-'));
    root = join(base, 'workspace'); source = join(base, 'source'); bin = join(base, 'bin');
    [root, source, bin].forEach(path => mkdirSync(path));
    git(source, 'init', '-b', 'main');
    writeFileSync(join(source, 'app.txt'), 'original\n');
    git(source, 'add', 'app.txt');
    git(source, '-c', 'user.name=Offline', '-c', 'user.email=offline@example.invalid', 'commit', '-m', 'offline fixture');
    git(source, 'remote', 'add', 'origin', repository.url);
    git(source, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(source, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const hook = join(source, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${join(base, 'hook-ran')}'\n`); chmodSync(hook, 0o700);
    // Network-free clone boundary; all ref/config/checkout operations use real Git.
    // First transient failure leaves partial user data to exercise quarantine on retry.
    writeFileSync(join(bin, 'git'), `#!/usr/bin/python3\nimport os, shutil, sys\nargs=sys.argv[1:]\nbase=${JSON.stringify(base)}\nsource=${JSON.stringify(source)}\nif 'clone' in args:\n    if os.path.exists(os.path.join(base, 'fail-once')) and not os.path.exists(os.path.join(base, 'attempted')):\n        open(os.path.join(base, 'attempted'), 'w').close()\n        os.mkdir(args[-1])\n        with open(os.path.join(args[-1], 'user-draft.txt'), 'w') as file: file.write('preserve this draft')\n        sys.exit(128)\n    shutil.copytree(source, args[-1])\n    sys.exit(0)\nos.execv('/usr/bin/git', ['git']+args)\n`);
    chmodSync(join(bin, 'git'), 0o700);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('first clone exits 128, second open reuses owned VM and quarantines partial data without running hooks', async () => {
    writeFileSync(join(base, 'fail-once'), '');
    const sandbox = { name: `h-${sessionId}`, persistent: true, status: 'running',
      tags: { harnessSession: sessionId, harnessRepository: hash } as Record<string, string>,
      update: jest.fn(async (input: { tags?: Record<string, string> }) => { if (input.tags) sandbox.tags = input.tags; }),
      runCommand: jest.fn(async () => {
        const result = helper();
        return { cmdId: 'cmd_bootstrap', exitCode: result.status, wait: async () => ({ exitCode: result.status }), kill: jest.fn(),
          logs: () => Object.assign((async function* () { if (result.stderr) yield { stream: 'stderr', data: result.stderr }; })(), { close() {} }) };
      }) };
    (Sandbox.get as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValue(sandbox);
    (Sandbox.create as jest.Mock).mockResolvedValue(sandbox);
    await expect(openWorkspace({ sessionId, repository })).rejects.toMatchObject({ code: 'REPOSITORY_CLONE_FAILED' });
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(join(stage(), 'checkout', 'user-draft.txt'), 'utf8')).toBe('preserve this draft');
    await openWorkspace({ sessionId, repository });
    expect(Sandbox.create).toHaveBeenCalledTimes(1);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2);
    expect(sandbox.tags.harnessReady).toBe('true');
    const quarantine = readdirSync(stage()).find(name => name.startsWith('quarantine-'))!;
    expect(readFileSync(join(stage(), quarantine, 'user-draft.txt'), 'utf8')).toBe('preserve this draft');
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(base, 'hook-ran'))).toBe(false);
  });
  test('prior valid checkout becomes ready without checkout/resetting tracked or untracked work', () => {
    cpSync(source, root, { recursive: true });
    writeFileSync(join(root, 'app.txt'), 'user modified\n');
    writeFileSync(join(root, 'new-file.txt'), 'user new file');
    expect(helper().status).toBe(0);
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('user modified\n');
    expect(readFileSync(join(root, 'new-file.txt'), 'utf8')).toBe('user new file');
    expect(existsSync(stage())).toBe(false);
    expect(existsSync(join(base, 'hook-ran'))).toBe(false);
  });
  test.each(['remote', 'ref', 'not-repository'])('rejects populated %s mismatch without resetting data or trying clone', variant => {
    if (variant !== 'not-repository') cpSync(source, root, { recursive: true });
    if (variant === 'remote') git(root, 'remote', 'set-url', 'origin', 'https://other.example.invalid/repo.git');
    if (variant === 'ref') {
      writeFileSync(join(root, 'other.txt'), 'other'); git(root, 'add', 'other.txt');
      git(root, '-c', 'user.name=Offline', '-c', 'user.email=offline@example.invalid', 'commit', '-m', 'other');
      git(root, 'checkout', '--detach', 'HEAD');
      git(root, 'branch', '-f', 'main', 'HEAD~1');
    }
    writeFileSync(join(root, 'user-draft.txt'), 'never reset');
    expect(helper().status).toBe(74);
    expect(readFileSync(join(root, 'user-draft.txt'), 'utf8')).toBe('never reset');
    expect(existsSync(stage())).toBe(false);
  });
  test('foreign marker is never reused or removed', () => {
    mkdirSync(stage());
    writeFileSync(join(stage(), 'owner.json'), JSON.stringify({ sessionId: randomUUID() }));
    writeFileSync(join(stage(), 'user-draft.txt'), 'foreign user data');
    expect(helper().status).toBe(75);
    expect(readFileSync(join(stage(), 'user-draft.txt'), 'utf8')).toBe('foreign user data');
    expect(readdirSync(root)).toEqual([]);
  });
});