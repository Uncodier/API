import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('@/lib/services/workflow-robot/materialize', () => ({
  materializeRunFromGraph: jest.fn(),
}));

jest.mock('@/lib/services/workflow-robot/run-plan', () => ({
  runWorkflowPlan: jest.fn(),
}));

jest.mock('@/lib/services/workflow-robot/cron-window', () => ({
  WORKFLOW_CRON_WINDOW_MS: 120_000,
  isCronDueInWindow: jest.fn(() => ({
    due: true,
    windowKey: '2026-09-16T15:00',
  })),
}));

jest.mock('@/lib/timezone', () => ({
  DEFAULT_TIMEZONE: 'UTC',
  normalizeTimezone: jest.fn(() => 'UTC'),
  resolveClientTimezone: jest.fn(async () => 'UTC'),
}));

import { GET } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';

describe('cron workflows route', () => {
  const trigger = {
    id: 'trigger-1',
    instance_id: 'instance-1',
    template_plan_id: 'template-1',
    config: { cron: '0 9 * * *', timezone: 'UTC' },
    site_id: 'site-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';

    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest.fn(async () => ({ data: [trigger], error: null })),
    };
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  });

  it('does not execute an existing run returned by idempotency replay', async () => {
    (materializeRunFromGraph as jest.Mock).mockResolvedValue({
      template_plan_id: 'template-1',
      run_plan_id: 'existing-plan',
      workflow_run_id: 'existing-run',
      dry_run: false,
      steps: [],
    } as never);

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    expect(runWorkflowPlan).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      results: [{ trigger_id: 'trigger-1', skipped: 'duplicate' }],
    });
  });

  it('executes a newly materialized run once', async () => {
    (materializeRunFromGraph as jest.Mock).mockResolvedValue({
      template_plan_id: 'template-1',
      run_plan_id: 'new-plan',
      workflow_run_id: 'new-run',
      dry_run: false,
      steps: [{ id: 'step-1' }],
    } as never);
    (runWorkflowPlan as jest.Mock).mockResolvedValue({
      run_plan_id: 'new-plan',
      status: 'completed',
      steps_completed: 1,
    } as never);

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    expect(runWorkflowPlan).toHaveBeenCalledTimes(1);
    expect(runWorkflowPlan).toHaveBeenCalledWith('new-plan');
  });

  it('retries an existing run whose claim is recoverable', async () => {
    (materializeRunFromGraph as jest.Mock).mockResolvedValue({
      template_plan_id: 'template-1',
      run_plan_id: 'expired-plan',
      workflow_run_id: 'existing-run',
      dry_run: false,
      steps: [],
      resume_existing_run: true,
    } as never);
    (runWorkflowPlan as jest.Mock).mockResolvedValue({
      run_plan_id: 'expired-plan',
      status: 'completed',
      steps_completed: 1,
    } as never);

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    expect(runWorkflowPlan).toHaveBeenCalledWith('expired-plan');
  });
});
