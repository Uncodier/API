import { recordStepInfraTransientStep, MAX_INFRA_RETRIES } from '../../../app/api/cron/shared/cron-execute-steps-phase-helpers';
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

describe('recordStepInfraTransientStep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('increments infra_retry_count and leaves status alone under cap', async () => {
    const mockSteps = [{ id: 'step_1', status: 'in_progress', infra_retry_count: 1 }];
    
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({ data: { steps: mockSteps } });
    
    const result = await recordStepInfraTransientStep('plan_1', 'step_1', 'Sandbox Gone 410');
    
    expect(result.exhausted).toBe(false);
    expect(result.infraCount).toBe(2);
    
    expect(supabaseAdmin.update).toHaveBeenCalledWith(expect.objectContaining({
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
    
    (supabaseAdmin.single as jest.Mock).mockResolvedValue({ data: { steps: mockSteps } });
    
    const result = await recordStepInfraTransientStep('plan_1', 'step_1', 'Sandbox Gone 410');
    
    expect(result.exhausted).toBe(true);
    expect(result.infraCount).toBe(MAX_INFRA_RETRIES);
    
    expect(supabaseAdmin.update).toHaveBeenCalledWith(expect.objectContaining({
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
});
