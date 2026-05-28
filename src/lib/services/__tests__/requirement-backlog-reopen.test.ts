import { isRequirementReopened } from '../requirement-backlog';
import { supabaseAdmin } from '@/lib/database/supabase-server';

jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('isRequirementReopened', () => {
  let selectMock: jest.Mock;
  let eqMock: jest.Mock;
  let orderMock: jest.Mock;
  let limitMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    limitMock = jest.fn();
    orderMock = jest.fn().mockReturnValue({ limit: limitMock });
    eqMock = jest.fn().mockReturnValue({ order: orderMock });
    selectMock = jest.fn().mockReturnValue({ eq: eqMock });

    (supabaseAdmin.from as jest.Mock).mockReturnValue({
      select: selectMock,
    });
  });

  it('returns false for empty history', async () => {
    limitMock.mockResolvedValue({ data: [] });
    
    const result = await isRequirementReopened('req-1');
    expect(result).toBe(false);
  });

  it('returns false when history only has non-terminal states (initial delivery)', async () => {
    limitMock.mockResolvedValue({
      data: [
        { stage: 'in-progress', created_at: '2026-05-27T10:00:00Z' },
        { stage: 'backlog', created_at: '2026-05-27T09:00:00Z' }
      ]
    });
    
    const result = await isRequirementReopened('req-1');
    expect(result).toBe(false);
  });

  it('returns false when latest state is terminal', async () => {
    limitMock.mockResolvedValue({
      data: [
        { stage: 'done', created_at: '2026-05-27T10:00:00Z' },
        { stage: 'in-progress', created_at: '2026-05-27T09:00:00Z' }
      ]
    });
    
    const result = await isRequirementReopened('req-1');
    expect(result).toBe(false);
  });

  it('returns true when latest state is non-terminal but a previous state was terminal (reopen)', async () => {
    limitMock.mockResolvedValue({
      data: [
        { stage: 'in-progress', created_at: '2026-05-27T11:00:00Z' }, // Reopened
        { stage: 'done', created_at: '2026-05-27T10:00:00Z' },        // Previously terminal
        { stage: 'in-progress', created_at: '2026-05-27T09:00:00Z' }
      ]
    });
    
    const result = await isRequirementReopened('req-1');
    expect(result).toBe(true);
  });
  
  it('handles null/undefined stages gracefully', async () => {
    limitMock.mockResolvedValue({
      data: [
        { stage: null, created_at: '2026-05-27T11:00:00Z' },
        { stage: 'completed', created_at: '2026-05-27T10:00:00Z' },
      ]
    });
    
    const result = await isRequirementReopened('req-1');
    expect(result).toBe(true);
  });
});
