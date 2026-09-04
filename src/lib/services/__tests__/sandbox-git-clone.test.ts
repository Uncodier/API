import { describe, expect, it } from '@jest/globals';
import { buildCloneIntoWorkDirScript } from '@/lib/services/sandbox-git-clone';
import { buildFetchOriginArgs, stripGitHubTokenFromRemote } from '@/lib/services/sandbox-git-identity';
import { SANDBOX_WORK_DIR } from '@/lib/services/sandbox-constants';

describe('v3 git layout invariant', () => {
  it('clones into /vercel/sandbox and flattens a nested .git', () => {
    const script = buildCloneIntoWorkDirScript(
      SANDBOX_WORK_DIR,
      'https://x-access-token:t@github.com/org/repo.git',
    );
    expect(script).toContain('WORKDIR="/vercel/sandbox"');
    expect(script).toContain('git clone --depth 1');
    expect(script).toContain('mindepth 2 -maxdepth 3');
    expect(script).toContain('"$WORKDIR/.git"');
  });

  it('strips the token from the origin URL after clone', () => {
    expect(
      stripGitHubTokenFromRemote('https://x-access-token:secret@github.com/org/repo.git'),
    ).toBe('https://github.com/org/repo.git');
  });

  it('does not shallow-fetch on resume (depth=1 is clone-only)', () => {
    expect(buildFetchOriginArgs('feature/req-abc')).toEqual([
      'fetch',
      'origin',
      '+refs/heads/feature/req-abc:refs/remotes/origin/feature/req-abc',
      '--prune',
    ]);
    expect(buildFetchOriginArgs('feature/req-abc', true)).toContain('--depth=1');
  });
});
