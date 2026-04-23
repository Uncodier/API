import { describe, expect, it } from '@jest/globals';
import { persistedSnapshotMatchesBinding } from '@/lib/services/sandbox-persisted-snapshot-policy';
import type { GitBinding } from '@/lib/services/requirement-git-binding';

const reqId = '21c35450-1234-5678-9abc-def012345678';

const binding: GitBinding = {
  kind: 'applications',
  org: 'AcmeOrg',
  repo: 'apps',
  default_branch: 'main',
};

describe('persistedSnapshotMatchesBinding', () => {
  it('returns true when repo_url is null', () => {
    expect(persistedSnapshotMatchesBinding(reqId, binding, null)).toBe(true);
  });

  it('returns false when org mismatches', () => {
    const url = `https://github.com/OtherOrg/${binding.repo}/tree/feature/req-${reqId}`;
    expect(persistedSnapshotMatchesBinding(reqId, binding, url)).toBe(false);
  });

  it('returns false when branch does not encode requirement', () => {
    const url = `https://github.com/${binding.org}/${binding.repo}/tree/feature/other-req`;
    expect(persistedSnapshotMatchesBinding(reqId, binding, url)).toBe(false);
  });

  it('returns true for canonical tree URL', () => {
    const url = `https://github.com/${binding.org}/${binding.repo}/tree/feature/req-${reqId}--slug`;
    expect(persistedSnapshotMatchesBinding(reqId, binding, url)).toBe(true);
  });
});

