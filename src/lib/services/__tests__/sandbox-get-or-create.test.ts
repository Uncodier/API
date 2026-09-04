import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@vercel/sandbox', () => {
  const getOrCreate = jest.fn(async (opts: { onCreate?: (sbx: unknown) => Promise<void> }) => {
    const fake = { name: 'req-21c35450-abcd1234', sandboxId: 'sb_1' };
    if (opts?.onCreate) await opts.onCreate(fake);
    return fake;
  });
  return { Sandbox: { getOrCreate, get: jest.fn(), create: jest.fn() } };
});

jest.mock('@/lib/services/sandbox-git-clone', () => ({
  cloneRepoIntoWorkDir: jest.fn(async () => undefined),
}));

jest.mock('@/lib/services/sandbox-git-identity', () => ({
  fetchOriginBranch: jest.fn(async () => ({ exitCode: 0, stderr: '' })),
  installGitIdentity: jest.fn(async () => undefined),
}));

jest.mock('@/lib/services/sandbox-npm', () => ({
  ensureNpmDeps: jest.fn(async () => ({ skipped: true, usedCi: false, reason: 'lockfile-hash-match' })),
}));

jest.mock('@/lib/services/sandbox-git-layout', () => ({
  assertPlatformGitLayout: jest.fn(async () => undefined),
}));

jest.mock('@/lib/services/sandbox-on-resume', () => ({
  resumeRequirementWorkspace: jest.fn(async () => undefined),
}));

describe('getOrCreateRequirementSandbox', () => {
  it('clones into WORK_DIR on create via onCreate', async () => {
    const { getOrCreateRequirementSandbox } = await import('@/lib/services/sandbox-get-or-create');
    const { cloneRepoIntoWorkDir } = await import('@/lib/services/sandbox-git-clone');
    const result = await getOrCreateRequirementSandbox({
      name: 'req-21c35450-abcd1234',
      tags: { kind: 'requirement' },
      authRepoUrl: 'https://x-access-token:t@github.com/org/repo.git',
    });
    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
    expect(cloneRepoIntoWorkDir).toHaveBeenCalled();
  });
});
