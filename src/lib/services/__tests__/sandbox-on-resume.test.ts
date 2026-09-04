import { describe, expect, it, jest } from '@jest/globals';

const order: string[] = [];
const commands: string[][] = [];

jest.mock('@/lib/services/sandbox-git-identity', () => ({
  installGitIdentity: jest.fn(async () => {
    order.push('identity');
  }),
  fetchOriginBranch: jest.fn(async (_sbx: unknown, branch?: string | null) => {
    order.push(branch ? `fetch:${branch}` : 'fetch');
    return { exitCode: 0, stderr: '' };
  }),
}));

jest.mock('@/lib/services/sandbox-npm', () => ({
  ensureNpmDeps: jest.fn(async () => {
    order.push('npm');
    return { skipped: true, usedCi: false, reason: 'lockfile-hash-match' };
  }),
}));

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    getKnownBranches: jest.fn(async () => []),
  },
}));

const REQ = 'f4a0ca37-c25b-4309-9f00-88f93de805f7';
const FEATURE = `feature/req-${REQ}`;

function fakeSandbox(head: string, lsRemote = '') {
  return {
    runCommand: jest.fn(async (opts: { args?: string[] }) => {
      const args = opts.args || [];
      commands.push(args);
      if (args[0] === 'rev-parse') {
        return { stdout: async () => head, stderr: async () => '', exitCode: 0 };
      }
      if (args[0] === 'ls-remote') {
        return {
          stdout: async () => lsRemote,
          stderr: async () => '',
          exitCode: 0,
        };
      }
      if (args[0] === 'status') {
        return { stdout: async () => '', stderr: async () => '', exitCode: 0 };
      }
      if (args[0] === 'checkout') {
        order.push(`checkout:${args.join(' ')}`);
        return { stdout: async () => '', stderr: async () => '', exitCode: 0 };
      }
      if (args[0] === 'reset') {
        order.push(`reset:${args[args.length - 1]}`);
        return { stdout: async () => '', stderr: async () => '', exitCode: 0 };
      }
      return { stdout: async () => 'SKIP', stderr: async () => '', exitCode: 0 };
    }),
  };
}

describe('resumeRequirementWorkspace', () => {
  it('installs git identity before fetch', async () => {
    order.length = 0;
    commands.length = 0;
    const { resumeRequirementWorkspace } = await import('@/lib/services/sandbox-on-resume');
    await resumeRequirementWorkspace(fakeSandbox('feature/req-abc') as never, '/vercel/sandbox', {
      authRepoUrl: 'https://x-access-token:t@github.com/org/repo.git',
      syncToOrigin: false,
    });
    expect(order.indexOf('identity')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('identity')).toBeLessThan(order.findIndex((s) => s.startsWith('fetch')));
    expect(order.some((s) => s.startsWith('reset:'))).toBe(false);
  });

  it('checks out feature/req-* when HEAD is main and never resets origin/main', async () => {
    order.length = 0;
    commands.length = 0;
    const { resumeRequirementWorkspace } = await import('@/lib/services/sandbox-on-resume');
    await resumeRequirementWorkspace(
      fakeSandbox('main', `abc\trefs/heads/${FEATURE}`) as never,
      '/vercel/sandbox',
      {
        authRepoUrl: 'https://x-access-token:t@github.com/org/repo.git',
        syncToOrigin: true,
        requirementId: REQ,
      },
    );
    expect(order.some((s) => s.includes(`checkout:`) && s.includes(FEATURE))).toBe(true);
    expect(order).not.toContain('reset:origin/main');
  });
});
