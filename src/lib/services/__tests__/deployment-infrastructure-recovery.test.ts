import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  DeploymentRecoveryDatabaseError,
  deploymentRecoveryIdentity,
  reconcileReadyDeployment,
} from '../deployment-infrastructure-recovery';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: jest.fn() },
}));

const mockRpc = supabaseAdmin.rpc as unknown as jest.MockedFunction<
  (...args: any[]) => Promise<{ data: any; error: any }>
>;
const input = {
  requirementId: '21c35450-1234-4abc-9def-0123456789ab',
  siteId: '31c35450-1234-4abc-9def-0123456789ab',
  instanceId: '41c35450-1234-4abc-9def-0123456789ab',
  branch: 'feature/req-21c35450-1234-4abc-9def-0123456789ab',
  commitSha: 'abcdef1234567890',
  deploymentId: 'dpl_ready',
  previewUrl: 'https://preview.example.test',
};

describe('atomic deployment infrastructure recovery', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('uses one recovery RPC with a deterministic idempotency identity', async () => {
    mockRpc.mockResolvedValue({
      data: {
        state: 'applied',
        matched: true,
        recovered: true,
        requirement_reopened: true,
        plan_ids: ['plan-1'],
        step_ids: ['step-1'],
      },
      error: null,
    });

    await expect(reconcileReadyDeployment(input)).resolves.toEqual({
      state: 'applied',
      matched: true,
      recovered: true,
      requirementReopened: true,
      planIds: ['plan-1'],
      stepIds: ['step-1'],
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'recover_ready_deployment_infrastructure',
      expect.objectContaining({
        p_requirement_id: input.requirementId,
        p_branch: input.branch,
        p_commit_sha: input.commitSha,
        p_recovery_id: deploymentRecoveryIdentity(input),
        p_allow_legacy: false,
      }),
    );
  });

  it('passes legacy authority only when explicitly requested', async () => {
    mockRpc.mockResolvedValue({
      data: {
        state: 'guarded',
        matched: true,
        recovered: false,
        requirement_reopened: false,
        plan_ids: [],
        step_ids: [],
      },
      error: null,
    });
    await reconcileReadyDeployment({
      ...input,
      allowLegacySystemCircuit: true,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'recover_ready_deployment_infrastructure',
      expect.objectContaining({ p_allow_legacy: true }),
    );
  });

  it('preserves typed database errors for workflow retry classification', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        message: 'serialization failure',
        code: '40001',
        details: 'concurrent update',
        hint: 'retry',
      },
    });

    const error = await reconcileReadyDeployment(input).catch((caught) => caught);
    expect(error).toBeInstanceOf(DeploymentRecoveryDatabaseError);
    expect(error).toMatchObject({
      code: '40001',
      details: 'concurrent update',
      hint: 'retry',
    });
  });
});
