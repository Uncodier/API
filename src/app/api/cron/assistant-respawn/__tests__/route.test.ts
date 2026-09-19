import { jest } from '@jest/globals';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('@/lib/services/robot-instance/assistant-respawn', () => ({
  LOOKBACK_MS: 30 * 60 * 1000,
  countRecentRespawns: jest.fn(async () => 0),
  evaluateInstanceStall: jest.fn(() => 'respawn'),
  spawnSilentContinueWorkflow: jest.fn(),
}));

import { GET } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { spawnSilentContinueWorkflow } from '@/lib/services/robot-instance/assistant-respawn';

function queryEndingInLimit(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(result as never),
  };
}

function activePlanQuery(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result as never),
  };
}

describe('assistant respawn cron route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('does not respawn an execution owned by the workflow runner', async () => {
    const recentLogsQuery = queryEndingInLimit({
      data: [{ instance_id: 'instance-1' }],
      error: null,
    });
    const instanceLogsQuery = queryEndingInLimit({
      data: [{
        log_type: 'tool_call',
        message: 'sendEmail',
        created_at: '2026-09-18T15:05:00.000Z',
        details: { plan_id: 'workflow-plan-1' },
        site_id: 'site-1',
        user_id: 'user-1',
      }],
      error: null,
    });
    const planQuery = activePlanQuery({
      data: { metadata: { workflow_run: true } },
      error: null,
    });

    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(recentLogsQuery)
      .mockReturnValueOnce(instanceLogsQuery)
      .mockReturnValueOnce(planQuery);

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      results: [{ instance_id: 'instance-1', status: 'skipped_workflow_managed' }],
    });
  });

  it('does not respawn a requirement-managed plan', async () => {
    const recentLogsQuery = queryEndingInLimit({
      data: [{ instance_id: 'instance-1' }],
      error: null,
    });
    const instanceLogsQuery = queryEndingInLimit({
      data: [{
        log_type: 'tool_call',
        message: 'sandbox_push_checkpoint',
        created_at: '2026-09-18T15:05:00.000Z',
        details: { plan_id: 'requirement-plan-1' },
        site_id: 'site-1',
        user_id: 'user-1',
      }],
      error: null,
    });
    const planQuery = activePlanQuery({
      data: { metadata: { requirement_id: 'requirement-1' } },
      error: null,
    });

    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(recentLogsQuery)
      .mockReturnValueOnce(instanceLogsQuery)
      .mockReturnValueOnce(planQuery);

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      results: [{ instance_id: 'instance-1', status: 'skipped_workflow_managed' }],
    });
  });
});
