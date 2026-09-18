import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const limit = jest.fn() as jest.MockedFunction<
  (...args: number[]) => Promise<{ data: any[]; error: any }>
>;
const rpc = jest.fn(async (name: string) => ({
  data: name === 'acquire_deployment_recovery_scan_lease' ? true : null,
  error: null,
}));
const query: Record<string, any> = {
  select: jest.fn(),
  in: jest.fn(),
  contains: jest.fn(),
  order: jest.fn(),
  or: jest.fn(),
  gt: jest.fn(),
  limit,
};
for (const method of ['select', 'in', 'contains', 'order', 'or', 'gt'] as const) {
  query[method].mockReturnValue(query);
}

const getRequirementGitBinding = jest.fn(async () => ({
  org: 'uncodie',
  repo: 'app',
}));
const pollGitHubDeploymentForSha = jest.fn(async () => ({
  state: 'pending',
  previewUrl: null,
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => query),
    rpc,
  },
}));
jest.mock('../requirement-git-binding', () => ({
  getRequirementGitBinding,
}));
jest.mock('../github-deployment-status', () => ({
  fetchGitHubBranchTipSha: jest.fn(),
  pollGitHubDeploymentForSha,
}));
jest.mock('../deployment-infrastructure-recovery', () => ({
  reconcileReadyDeployment: jest.fn(),
}));

function waitingPlan(id: string, requirementId: string) {
  return {
    id,
    updated_at: `2026-09-17T20:00:0${id.endsWith('1') ? '1' : '2'}.000Z`,
    instance_id: `instance-${id}`,
    site_id: `site-${id}`,
    metadata: { requirement_id: requirementId },
    steps: [{
      id: `step-${id}`,
      infrastructure_kind: 'deployment',
      infrastructure_failure_provenance: 'deployment_infrastructure',
      infrastructure_waiting: true,
      infrastructure_correlation: {
        requirement_id: requirementId,
        plan_id: id,
        step_id: `step-${id}`,
        branch: `feature/${requirementId}`,
        commit_sha: `sha-${id}`,
      },
    }],
  };
}

describe('deployment infrastructure fallback pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CRON_LEGACY_DEPLOYMENT_RECOVERY_IDS;
  });

  it('skips a concurrent scan when the durable lease is held', async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const { reconcilePendingDeploymentInfrastructureWaits } = await import(
      '../deployment-infrastructure-fallback'
    );

    await expect(
      reconcilePendingDeploymentInfrastructureWaits(1),
    ).resolves.toEqual({ checked: 0, recovered: 0 });
    expect(limit).not.toHaveBeenCalled();
  });

  it('scans every filtered page instead of stopping at a fixed window', async () => {
    const pollCountsWhenPageLoaded: number[] = [];
    limit
      .mockImplementationOnce(async () => {
        pollCountsWhenPageLoaded.push(
          pollGitHubDeploymentForSha.mock.calls.length,
        );
        return {
          data: [waitingPlan('plan-1', 'requirement-1')],
          error: null,
        };
      })
      .mockImplementationOnce(async () => {
        pollCountsWhenPageLoaded.push(
          pollGitHubDeploymentForSha.mock.calls.length,
        );
        return {
          data: [waitingPlan('plan-2', 'requirement-2')],
          error: null,
        };
      })
      .mockImplementationOnce(async () => {
        pollCountsWhenPageLoaded.push(
          pollGitHubDeploymentForSha.mock.calls.length,
        );
        return { data: [], error: null };
      });

    const { reconcilePendingDeploymentInfrastructureWaits } = await import(
      '../deployment-infrastructure-fallback'
    );
    await expect(
      reconcilePendingDeploymentInfrastructureWaits(1),
    ).resolves.toEqual({ checked: 2, recovered: 0 });

    expect(query.contains).toHaveBeenCalledWith('steps', [{
      infrastructure_kind: 'deployment',
      infrastructure_failure_provenance: 'deployment_infrastructure',
    }]);
    expect(limit).toHaveBeenCalledTimes(3);
    expect(query.gt).toHaveBeenNthCalledWith(1, 'id', 'plan-1');
    expect(query.gt).toHaveBeenNthCalledWith(2, 'id', 'plan-2');
    expect(pollGitHubDeploymentForSha).toHaveBeenCalledTimes(2);
    expect(pollCountsWhenPageLoaded).toEqual([0, 1, 2]);
    expect(rpc).toHaveBeenCalledWith(
      'release_deployment_recovery_scan_lease',
      expect.any(Object),
    );
  });

  it('continues after one recovery candidate fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    limit
      .mockResolvedValueOnce({
        data: [
          waitingPlan('plan-1', 'requirement-1'),
          waitingPlan('plan-2', 'requirement-2'),
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    getRequirementGitBinding
      .mockRejectedValueOnce(new Error('binding unavailable'))
      .mockResolvedValueOnce({ org: 'uncodie', repo: 'app' });

    const { reconcilePendingDeploymentInfrastructureWaits } = await import(
      '../deployment-infrastructure-fallback'
    );
    await expect(
      reconcilePendingDeploymentInfrastructureWaits(2),
    ).resolves.toEqual({ checked: 2, recovered: 0 });

    expect(pollGitHubDeploymentForSha).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
