import { decideFeatureBranchAttach } from '@/lib/services/sandbox-git-push';

describe('decideFeatureBranchAttach', () => {
  it('is a no-op when already on the feature branch', () => {
    expect(
      decideFeatureBranchAttach({
        detached: false,
        currentBranch: 'feature/req-abc',
      }),
    ).toBe('noop');
  });

  it('attaches from current HEAD when detached', () => {
    expect(
      decideFeatureBranchAttach({
        detached: true,
        currentBranch: 'HEAD',
      }),
    ).toBe('checkout-B-head');
  });

  it('attaches from current HEAD when leaving main (never origin/feature)', () => {
    expect(
      decideFeatureBranchAttach({
        detached: false,
        currentBranch: 'main',
      }),
    ).toBe('checkout-B-head');
  });
});
