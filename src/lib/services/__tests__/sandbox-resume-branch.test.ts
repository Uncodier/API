import { describe, expect, it } from '@jest/globals';
import {
  isDefaultGitBranch,
  pickRemoteFeatureBranch,
  pickResumeFeatureBranch,
  shouldResetResumeToOrigin,
} from '@/lib/services/sandbox-resume-branch';

const REQ = 'f4a0ca37-c25b-4309-9f00-88f93de805f7';
const FEATURE = `feature/req-${REQ}`;

describe('sandbox-resume-branch', () => {
  it('treats main/master/HEAD as the default branch', () => {
    expect(isDefaultGitBranch('main')).toBe(true);
    expect(isDefaultGitBranch('master')).toBe(true);
    expect(isDefaultGitBranch('HEAD')).toBe(true);
    expect(isDefaultGitBranch(FEATURE)).toBe(false);
  });

  it('picks feature/req-<id> from ls-remote', () => {
    const stdout = [
      `abc123\trefs/heads/main`,
      `def456\trefs/heads/${FEATURE}`,
    ].join('\n');
    expect(pickRemoteFeatureBranch(stdout, REQ)).toBe(FEATURE);
  });

  it('falls back to knownBranches when ls-remote has no feature', () => {
    expect(
      pickResumeFeatureBranch({
        requirementId: REQ,
        lsRemoteStdout: 'abc\trefs/heads/main',
        knownBranches: [FEATURE],
      }),
    ).toBe(FEATURE);
  });

  it('never resets origin/main when a feature branch exists', () => {
    expect(
      shouldResetResumeToOrigin({
        syncToOrigin: true,
        porcelain: '',
        currentBranch: 'main',
        featureBranch: FEATURE,
      }),
    ).toBe(false);
  });

  it('resets a clean feature tip to origin', () => {
    expect(
      shouldResetResumeToOrigin({
        syncToOrigin: true,
        porcelain: '',
        currentBranch: FEATURE,
        featureBranch: FEATURE,
      }),
    ).toBe(true);
  });

  it('skips reset when the tree is dirty or sync is off', () => {
    expect(
      shouldResetResumeToOrigin({
        syncToOrigin: true,
        porcelain: ' M docs/a.md',
        currentBranch: FEATURE,
        featureBranch: FEATURE,
      }),
    ).toBe(false);
    expect(
      shouldResetResumeToOrigin({
        syncToOrigin: false,
        porcelain: '',
        currentBranch: FEATURE,
        featureBranch: FEATURE,
      }),
    ).toBe(false);
  });
});
