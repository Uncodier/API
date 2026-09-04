import { describe, expect, it, jest } from '@jest/globals';

const order: string[] = [];

jest.mock('@/lib/services/sandbox-git-identity', () => ({
  installGitIdentity: jest.fn(async () => {
    order.push('identity');
  }),
  fetchOriginBranch: jest.fn(async () => {
    order.push('fetch');
    return { exitCode: 0, stderr: '' };
  }),
}));

jest.mock('@/lib/services/sandbox-npm', () => ({
  ensureNpmDeps: jest.fn(async () => {
    order.push('npm');
    return { skipped: true, usedCi: false, reason: 'lockfile-hash-match' };
  }),
}));

function fakeSandbox() {
  return {
    runCommand: jest.fn(async (opts: { args?: string[] }) => {
      const args = opts.args || [];
      if (args[0] === 'rev-parse') {
        return { stdout: async () => 'feature/req-abc', stderr: async () => '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: async () => '', stderr: async () => '', exitCode: 0 };
      }
      if (args[0] === 'reset') {
        order.push('reset');
        return { stdout: async () => '', stderr: async () => '', exitCode: 0 };
      }
      return { stdout: async () => 'SKIP', stderr: async () => '', exitCode: 0 };
    }),
  };
}

describe('resumeRequirementWorkspace', () => {
  it('installs git identity before fetch', async () => {
    order.length = 0;
    const { resumeRequirementWorkspace } = await import('@/lib/services/sandbox-on-resume');
    await resumeRequirementWorkspace(fakeSandbox() as never, '/vercel/sandbox', {
      authRepoUrl: 'https://x-access-token:t@github.com/org/repo.git',
      syncToOrigin: false,
    });
    expect(order.indexOf('identity')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('identity')).toBeLessThan(order.indexOf('fetch'));
    expect(order).not.toContain('reset');
  });
});
