const mockMaybeSingle = jest.fn();
const mockContains = jest.fn();
const mockIs = jest.fn();
const mockLimit = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => {
      const query = {
        select: jest.fn(),
        eq: jest.fn(),
        or: jest.fn(),
        order: jest.fn(),
        limit: mockLimit,
        contains: mockContains,
        is: mockIs,
        maybeSingle: mockMaybeSingle,
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      query.or.mockReturnValue(query);
      query.order.mockReturnValue(query);
      query.limit.mockReturnValue(query);
      query.contains.mockReturnValue(query);
      query.is.mockReturnValue(query);
      return query;
    }),
  },
}));

jest.mock('@/app/api/agents/tools/instance_plan/update/route', () => ({
  updateInstancePlanCore: jest.fn(),
}));
jest.mock('../assistant-turn', () => ({ processAssistantTurn: jest.fn() }));
jest.mock('@/lib/services/skills-service', () => ({
  SkillsService: { getSkillBySlugOrName: jest.fn() },
}));
jest.mock('@/app/api/cron/shared/step-git-prompts', () => ({
  getStepCheckpointPromptFragment: jest.fn(),
  getFileFreshnessPromptFragment: jest.fn(),
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));
jest.mock('@/lib/utils/redis-client', () => ({
  getRedisClient: jest.fn(),
}));

import { getActiveInstancePlan } from '../plan-steps';

describe('getActiveInstancePlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters ownership before limiting and falls back to a legacy plan', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: 'legacy-plan', metadata: {} },
        error: null,
      });

    await expect(getActiveInstancePlan(
      'instance-1',
      'site-1',
      'requirement-1',
    )).resolves.toEqual(expect.objectContaining({ id: 'legacy-plan' }));

    expect(mockContains).toHaveBeenCalledWith('metadata', {
      requirement_id: 'requirement-1',
    });
    expect(mockIs).toHaveBeenCalledWith('metadata->>requirement_id', null);
    expect(mockLimit).toHaveBeenCalledWith(1);
  });
});
