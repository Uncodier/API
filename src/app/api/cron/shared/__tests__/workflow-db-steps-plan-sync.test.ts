import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockConnect = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockSync = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;

jest.mock('@/lib/services/sandbox-recovery', () => ({
  connectOrRecreateRequirementSandbox: mockConnect,
}));

jest.mock('../plan-backlog-sync', () => ({
  syncBacklogAfterPlanCompleted: mockSync,
}));

import { syncCompletedPlanBacklogStep } from '../workflow-db-steps';

const plan = {
  id: 'plan-1',
  steps: [{ id: 'step-1', status: 'completed' }],
};

describe('syncCompletedPlanBacklogStep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSync.mockResolvedValue(undefined);
  });

  it('runs sandbox recovery and backlog synchronization inside the step', async () => {
    const sandbox = { id: 'sandbox-replacement' };
    mockConnect.mockResolvedValue({
      sandbox,
      sandboxId: 'sandbox-2',
    });

    await expect(syncCompletedPlanBacklogStep({
      requirementId: 'requirement-1',
      plan,
      sandboxId: 'sandbox-1',
      instanceType: 'applications',
      title: 'Requirement title',
      audit: { instanceId: 'instance-1', siteId: 'site-1' },
    })).resolves.toEqual({ effectiveSandboxId: 'sandbox-2' });

    expect(mockConnect).toHaveBeenCalledWith({
      sandboxId: 'sandbox-1',
      requirementId: 'requirement-1',
      instanceType: 'applications',
      title: 'Requirement title',
      audit: { instanceId: 'instance-1', siteId: 'site-1' },
    });
    expect(mockSync).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      plan,
      sandbox,
      audit: { instanceId: 'instance-1', siteId: 'site-1' },
    });
  });

  it('continues without a sandbox when recovery is unavailable', async () => {
    mockConnect.mockRejectedValue(new Error('sandbox unavailable'));

    await expect(syncCompletedPlanBacklogStep({
      requirementId: 'requirement-1',
      plan,
      sandboxId: 'sandbox-1',
      instanceType: 'applications',
      title: 'Requirement title',
    })).resolves.toEqual({ effectiveSandboxId: 'sandbox-1' });

    expect(mockSync).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      plan,
      sandbox: undefined,
      audit: undefined,
    });
  });
});
