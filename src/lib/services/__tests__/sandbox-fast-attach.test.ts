import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Sandbox } from '@vercel/sandbox';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOrRecreateRequirementSandbox } from '../sandbox-recovery';
import { inspectFastAttachWorkspace } from '../sandbox-fast-attach';
import { getSandboxHandle } from '../sandbox-sdk';
import { warmStartNamedSandbox } from '../sandbox-on-resume';
import { SandboxService } from '../sandbox-service';
import { verifyPlatformGitLayout } from '../sandbox-git-layout';
import { deleteRequirementSandboxes } from '../sandbox-lifecycle';

jest.mock('../sandbox-sdk', () => ({ getSandboxHandle: jest.fn(), sandboxIdentity: (s: { name: string }) => s.name }));
jest.mock('../sandbox-on-resume', () => ({ warmStartNamedSandbox: jest.fn() }));
jest.mock('../sandbox-service', () => ({ SandboxService: { getCurrentBranch: jest.fn(), createRequirementSandbox: jest.fn() } }));
jest.mock('../sandbox-git-layout', () => ({ verifyPlatformGitLayout: jest.fn(), isFatalGitLayoutReason: (reason: string) => /nested/.test(reason) }));
jest.mock('../sandbox-lifecycle', () => ({ deleteRequirementSandboxes: jest.fn() }));
jest.mock('@/lib/tools/requirement-status-core', () => ({ persistActiveSandboxId: jest.fn() }));
jest.mock('../cron-audit-log', () => ({ CronInfraEvent: { SANDBOX_REPROVISIONED: 'reprovisioned' }, logCronInfrastructureEvent: jest.fn() }));

const req = 'f4a0ca37-c25b-4309-9f00-88f93de805f7';
const branch = `feature/req-${req}--task`;
const params = { sandboxId: 'sandbox-1', requirementId: req, instanceType: 'applications', title: 'Task' };
const get = jest.mocked(getSandboxHandle);
const warm = jest.mocked(warmStartNamedSandbox);
const layout = jest.mocked(verifyPlatformGitLayout);
const branchLookup = jest.mocked(SandboxService.getCurrentBranch);
const create = jest.mocked(SandboxService.createRequirementSandbox);

function fixture(status = 'running') {
  const session = { sessionId: 'session-1', status };
  const stdout = jest.fn(async () => branch);
  const runCommand = jest.fn(async (_options: unknown) => ({ exitCode: 0, stdout }));
  const resume = jest.fn(async () => { session.status = 'running'; session.sessionId = 'session-new'; });
  const sandbox = { name: 'sandbox-1', currentSession: () => session, runCommand, resume } as unknown as Sandbox;
  get.mockResolvedValue(sandbox);
  return { sandbox, session, runCommand, resume, stdout };
}

beforeEach(() => {
  jest.clearAllMocks();
  layout.mockResolvedValue({ ok: true });
  branchLookup.mockResolvedValue(branch);
  warm.mockResolvedValue(undefined);
});

describe('opt-in mid-cycle sandbox attach', () => {
  it('fresh-checks every healthy attach without warm preparation, resume or DB lookup', async () => {
    const f = fixture();
    for (let turn = 0; turn < 3; turn++) {
      const result = await connectOrRecreateRequirementSandbox({ ...params, fastAttach: true });
      expect(result).toEqual({ sandbox: f.sandbox, sandboxId: params.sandboxId, recovered: false, branchName: branch });
    }
    expect(get).toHaveBeenCalledTimes(3);
    expect(f.runCommand).toHaveBeenCalledTimes(3);
    expect(warm).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(branchLookup).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const command = f.runCommand.mock.calls[0][0] as { args: string[]; timeoutMs: number; signal: AbortSignal };
    expect(command.timeoutMs).toBe(4000);
    expect(command.signal).toBeInstanceOf(AbortSignal);
    expect(command.args[1]).toContain('git rev-parse --show-toplevel');
    expect(command.args[1]).toContain('git symbolic-ref --quiet --short HEAD');
    expect(command.args[1]).not.toMatch(/fetch|install|next start|reset|checkout/);
  });

  it('retains warm behavior unless fast attach is explicitly requested', async () => {
    const f = fixture();
    await connectOrRecreateRequirementSandbox(params);
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith(f.sandbox, req, 'applications', { syncToOrigin: false });
    expect(layout).toHaveBeenCalledTimes(2);
  });

  it('warms a stopped/restored session even if its filesystem is intact', async () => {
    const f = fixture('stopped');
    await connectOrRecreateRequirementSandbox({ ...params, fastAttach: true });
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it.each(['main', 'HEAD', `feature/req-f4a0ca37-c25b-4309-9f00-88f93de805f8`])('rejects fast attach on branch %s and takes warm recovery', async (wrongBranch) => {
    const f = fixture();
    f.stdout.mockResolvedValue(wrongBranch);
    await connectOrRecreateRequirementSandbox({ ...params, fastAttach: true });
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('takes warm recovery for missing deps, stale lock hash or wrong root', async () => {
    const f = fixture();
    f.runCommand.mockResolvedValue({ exitCode: 1, stdout: f.stdout });
    await connectOrRecreateRequirementSandbox({ ...params, fastAttach: true });
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('detects SDK auto-resume during the fresh read-only check', async () => {
    const f = fixture();
    f.runCommand.mockImplementation(async () => {
      f.session.sessionId = 'new-restored-session';
      return { exitCode: 0, stdout: f.stdout };
    });
    await connectOrRecreateRequirementSandbox({ ...params, fastAttach: true });
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('does not accept a still-invalid workspace after warm recovery', async () => {
    fixture('stopped');
    layout.mockResolvedValue({ ok: false, reason: 'not a git work tree' });
    await expect(connectOrRecreateRequirementSandbox({ ...params, fastAttach: true })).rejects.toThrow('not ready after warm recovery');
    expect(deleteRequirementSandboxes).not.toHaveBeenCalled();
  });

  it('does not delete unpushed work if warm recovery still has the wrong branch', async () => {
    fixture('stopped');
    branchLookup.mockResolvedValue('main');
    await expect(connectOrRecreateRequirementSandbox({ ...params, fastAttach: true })).rejects.toThrow('expected requirement branch');
    expect(deleteRequirementSandboxes).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('still reprovisions a dead 410 sandbox', async () => {
    const f = fixture('stopped');
    f.resume.mockRejectedValue(new Error('410 sandbox gone'));
    const replacement = { name: 'replacement' } as Sandbox;
    create.mockResolvedValue({ sandbox: replacement, branchName: branch } as never);
    const result = await connectOrRecreateRequirementSandbox({ ...params, fastAttach: true });
    expect(result).toMatchObject({ recovered: true, sandboxId: 'replacement', branchName: branch });
    expect(warm).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable stdout', async () => {
    const f = fixture();
    f.stdout.mockRejectedValue(new Error('read failed'));
    expect(await inspectFastAttachWorkspace(f.sandbox, req, 'session-1')).toBeNull();
  });

  it('executes the real read-only readiness script against a local git fixture, preserving dirty files', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fast-attach-')));
    const f = fixture();
    try {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
      execFileSync('/usr/bin/git', ['init', '-q', root], { env });
      // Reuse existing repository objects read-only; never create a commit in the
      // workspace or fixture. Only package.json is materialized in the fixture.
      const objects = execFileSync('/usr/bin/git', ['rev-parse', '--git-path', 'objects'], { env }).toString().trim();
      writeFileSync(join(root, '.git', 'objects', 'info', 'alternates'), `${realpathSync(objects)}\n`);
      const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { env }).toString().trim();
      execFileSync('/usr/bin/git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: root, env });
      execFileSync('/usr/bin/git', ['update-ref', `refs/heads/${branch}`, head], { cwd: root, env });
      execFileSync('/usr/bin/git', ['checkout', 'HEAD', '--', 'package.json'], { cwd: root, env });
      const locks = execFileSync('/usr/bin/git', ['ls-tree', '--name-only', 'HEAD', '--', 'package-lock.json', 'npm-shrinkwrap.json'], { cwd: root, env }).toString().trim().split('\n').filter(Boolean);
      if (locks.length) {
        execFileSync('/usr/bin/git', ['checkout', 'HEAD', '--', ...locks], { cwd: root, env });
        const lock = locks.includes('package-lock.json') ? 'package-lock.json' : locks[0];
        writeFileSync(join(root, '.npm-lock-hash'), createHash('sha256').update(readFileSync(join(root, lock))).digest('hex'));
      }
      writeFileSync(join(root, 'uncommitted.txt'), 'preserve me');
      mkdirSync(join(root, 'node_modules'));
      let cwd = root;
      f.runCommand.mockImplementation(async (options) => {
        const opts = options as { args: string[] };
        // Map only the fixed VM root and GNU utility spelling to this macOS fixture.
        const args = opts.args.map((arg) => arg.replaceAll('/vercel/sandbox', root).replaceAll('sha256sum', 'shasum -a 256'));
        const result = spawnSync('/bin/sh', args, { cwd, env, encoding: 'utf8', timeout: 2000 });
        return { exitCode: result.status ?? 1, stdout: jest.fn(async () => result.stdout) };
      });
      const before = execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: root, env }).toString();
      expect(await inspectFastAttachWorkspace(f.sandbox, req, 'session-1')).toBe(branch);
      expect(execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: root, env }).toString()).toBe(before);
      writeFileSync(join(root, 'package.json'), '{"dependencies":{"changed":"1.0.0"}}');
      expect(await inspectFastAttachWorkspace(f.sandbox, req, 'session-1')).toBeNull();
      execFileSync('/usr/bin/git', ['checkout', 'HEAD', '--', 'package.json'], { cwd: root, env });
      rmSync(join(root, 'node_modules'), { recursive: true });
      expect(await inspectFastAttachWorkspace(f.sandbox, req, 'session-1')).toBeNull();
      mkdirSync(join(root, 'node_modules'));
      mkdirSync(join(root, 'app'));
      cwd = join(root, 'app');
      expect(await inspectFastAttachWorkspace(f.sandbox, req, 'session-1')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});