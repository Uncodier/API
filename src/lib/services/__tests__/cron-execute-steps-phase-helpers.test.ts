import {
  MAX_INFRA_RETRIES,
  recordStepInfraTransientStep,
  updatePlanStepStatusStep,
} from '../../../app/api/cron/shared/cron-execute-steps-phase-helpers';
import { supabaseAdmin } from '../../database/supabase-client';

jest.mock('@vercel/sandbox', () => ({}));
jest.mock('workflow', () => ({}));

jest.mock('../../database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(),
    update: jest.fn().mockReturnThis()
  }
}));

const mockedSupabase = supabaseAdmin as unknown as {
  single: jest.Mock;
  update: jest.Mock;
};

describe('recordStepInfraTransientStep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('increments infra_retry_count and leaves status alone under cap', async () => {
    const mockSteps = [{ id: 'step_1', status: 'in_progress', infra_retry_count: 1 }];
    
    mockedSupabase.single.mockResolvedValue({ data: { steps: mockSteps } });
    
    const result = await recordStepInfraTransientStep('plan_1', 'step_1', 'Sandbox Gone 410');
    
    expect(result.exhausted).toBe(false);
    expect(result.infraCount).toBe(2);
    
    expect(mockedSupabase.update).toHaveBeenCalledWith(expect.objectContaining({
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: 'step_1',
          status: 'in_progress',
          infra_retry_count: 2
        })
      ])
    }));
  });

  it('sets status to failed when cap is reached', async () => {
    const mockSteps = [{ id: 'step_1', status: 'in_progress', infra_retry_count: MAX_INFRA_RETRIES - 1 }];
    
    mockedSupabase.single.mockResolvedValue({ data: { steps: mockSteps } });
    
    const result = await recordStepInfraTransientStep('plan_1', 'step_1', 'Sandbox Gone 410');
    
    expect(result.exhausted).toBe(true);
    expect(result.infraCount).toBe(MAX_INFRA_RETRIES);
    
    expect(mockedSupabase.update).toHaveBeenCalledWith(expect.objectContaining({
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: 'step_1',
          status: 'failed',
          retry_count: 2,
          infra_retry_count: MAX_INFRA_RETRIES
        })
      ])
    }));
  });

  it('does not let a late infrastructure retry overwrite a terminal step', async () => {
    const mockSteps = [{
      id: 'step_1',
      status: 'completed',
      infra_retry_count: MAX_INFRA_RETRIES - 1,
    }];
    mockedSupabase.single.mockResolvedValue({ data: { steps: mockSteps } });

    await expect(
      recordStepInfraTransientStep('plan_1', 'step_1', 'Sandbox stream was closed'),
    ).resolves.toEqual({
      exhausted: false,
      infraCount: MAX_INFRA_RETRIES - 1,
    });
    expect(mockedSupabase.update).not.toHaveBeenCalled();
  });

  it('does not let a late failure overwrite a completed step', async () => {
    const mockSteps = [{ id: 'step_1', status: 'completed', retry_count: 0 }];
    mockedSupabase.single.mockResolvedValue({ data: { steps: mockSteps } });

    await updatePlanStepStatusStep('plan_1', 'step_1', 'failed', 'late error');

    expect(mockedSupabase.update).not.toHaveBeenCalled();
  });

  it('clears stale infrastructure errors when a retry completes', async () => {
    const mockSteps = [{
      id: 'step_1',
      status: 'in_progress',
      infra_retry_count: 2,
      error_message: 'Sandbox stream was closed',
    }];
    mockedSupabase.single.mockResolvedValue({ data: { steps: mockSteps } });

    await updatePlanStepStatusStep('plan_1', 'step_1', 'completed');

    expect(mockedSupabase.update).toHaveBeenCalledWith(expect.objectContaining({
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: 'step_1',
          status: 'completed',
          infra_retry_count: 0,
          error_message: null,
        }),
      ]),
    }));
  });
});
