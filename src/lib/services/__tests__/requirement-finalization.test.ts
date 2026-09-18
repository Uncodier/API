import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { finalizeRequirementExecution } from '../requirement-finalization';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: jest.fn() },
}));

const mockRpc = supabaseAdmin.rpc as unknown as jest.MockedFunction<
  (...args: any[]) => Promise<{ data: any; error: any }>
>;

describe('finalizeRequirementExecution', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('passes the execution generation and finalization identity', async () => {
    mockRpc.mockResolvedValue({
      data: {
        state: 'applied',
        effective_status: 'done',
        status_id: 'status-1',
      },
      error: null,
    });

    await expect(finalizeRequirementExecution({
      requirementId: 'requirement-1',
      siteId: 'site-1',
      instanceId: 'instance-1',
      expectedExecutionGeneration: 8,
      eventId: 'cycle-1',
      existingStatusId: 'status-1',
      status: 'done',
      message: 'Complete',
      repoUrl: 'https://github.com/acme/repo/tree/feature',
      previewUrl: 'https://preview.example.com',
      sourceCodeUrl: 'https://storage.example.com/source.zip',
      isComplete: true,
      markOnReview: false,
    })).resolves.toEqual({
      state: 'applied',
      effectiveStatus: 'done',
      statusId: 'status-1',
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_requirement_execution_atomic',
      expect.objectContaining({
        p_expected_execution_generation: 8,
        p_event_id: 'cycle-1',
        p_is_complete: true,
      }),
    );
  });

  it('surfaces a stale finalization without treating it as applied', async () => {
    mockRpc.mockResolvedValue({
      data: {
        state: 'stale',
        effective_status: 'in-progress',
      },
      error: null,
    });

    await expect(finalizeRequirementExecution({
      requirementId: 'requirement-1',
      siteId: 'site-1',
      instanceId: 'instance-1',
      expectedExecutionGeneration: 7,
      eventId: 'cycle-old',
      status: 'done',
      message: 'Complete',
      isComplete: true,
      markOnReview: false,
    })).resolves.toMatchObject({
      state: 'stale',
      effectiveStatus: 'in-progress',
    });
  });
});
