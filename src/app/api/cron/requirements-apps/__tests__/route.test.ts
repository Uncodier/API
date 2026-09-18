import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';

const mockBlockRequirementForProductAttemptBudget =
  jest.fn(async () => ({ state: 'applied', blocked: true }));
const mockResumeRequirementExecution = jest.fn(async () => undefined);
const mockRpc: any = jest.fn();

// Mocks
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
    rpc: mockRpc,
  },
}));

jest.mock('workflow/api', () => ({
  start: jest.fn(async () => ({ runId: 'test-workflow-run-id' })),
}));

jest.mock('../workflow', () => ({
  runCronAppsWorkflow: jest.fn(),
}));

jest.mock('../../shared/forced-cycle-wrapup-workflow', () => ({
  runForcedCycleWrapUpWorkflow: jest.fn(),
}));

jest.mock('../../maintenance/workflow', () => ({
  runMaintenanceWorkflow: jest.fn(),
}));

jest.mock('../../shared/cron-run-lock', () => ({
  CRON_RUN_LOCK_TTL_MS: 7_200_000,
  releaseRunLock: jest.fn(async () => true),
  getSupabaseUrlHostForLogs: jest.fn().mockReturnValue('mock-host'),
}));

jest.mock('@/lib/services/requirement-backlog', () => ({
  isBacklogComplete: jest.fn(),
  hasOutstandingWork: jest.fn(),
  outstandingGatingItems: jest.fn(),
}));

jest.mock('@/lib/services/requirement-onreview-sanitizer', () => ({
  runOnReviewSanitization: jest.fn(async () => ({
    requirementsSanitized: 0,
    itemsReopened: 0,
  })),
}));

jest.mock('@/lib/services/deployment-infrastructure-fallback', () => ({
  reconcilePendingDeploymentInfrastructureWaits: jest.fn(async () => ({
    checked: 0,
    recovered: 0,
  })),
}));

jest.mock('@/lib/services/requirement-execution-recovery', () => ({
  resumeRequirementExecutionOnUserAction: mockResumeRequirementExecution,
}));

jest.mock('@/lib/services/requirement-metadata-patch', () => ({
  blockRequirementForProductAttemptBudget:
    mockBlockRequirementForProductAttemptBudget,
  patchRequirementMetadataKeys: jest.fn(async () => ({
    runner_instance_id: 'inst-1',
  })),
}));

import { GET } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import * as backlogService from '@/lib/services/requirement-backlog';
import { patchRequirementMetadataKeys } from '@/lib/services/requirement-metadata-patch';
import { releaseRunLock } from '../../shared/cron-run-lock';

describe('Cron Requirements Apps Route', () => {
  let mockSupabase: any;

  function mockClaimBatches(
    batches: any[][],
    activation = { state: 'active', active_runs: 1 },
  ) {
    let claimIndex = 0;
    mockRpc.mockImplementation(async (functionName: string) => {
      if (functionName === 'activate_requirement_cron_run') {
        return { data: activation, error: null };
      }
      if (functionName === 'claim_requirement_cron_candidates') {
        return { data: batches[claimIndex++] || [], error: null };
      }
      throw new Error(`Unexpected RPC ${functionName}`);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    delete process.env.CRON_REQUIREMENT_EVALUATION_LIMIT;

    mockSupabase = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      like: jest.fn().mockReturnThis(),
      then: function(resolve: any) { resolve({ data: [], error: null }); },
    };

    (supabaseAdmin.from as jest.Mock).mockReturnValue(mockSupabase);
    mockClaimBatches([]);
  });

  it('returns 401 without correct authorization header', async () => {
    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer undefined' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('reports capacity only when eight real run leases are active', async () => {
    mockClaimBatches([[{ state: 'capacity_full', active_runs: 8 }]]);

    const res = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    await expect(res.json()).resolves.toMatchObject({
      message: 'Requirement cron capacity is full',
      activeRuns: 8,
      maxConcurrentRuns: 8,
      evaluatedRequirements: 0,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('processes requirements successfully', async () => {
    // Mock the initial query for requirements
    const mockRequirement = {
      id: 'req-1',
      status: 'in-progress',
      site_id: 'site-1',
      user_id: 'user-1',
      title: 'Build the automation',
      instructions: 'Implement the requirement',
      type: 'automation',
      backlog: { items: [] },
      metadata: {},
      cron: null,
    };
    mockClaimBatches([[
      {
        state: 'claimed',
        requirement: mockRequirement,
        run_id: 'test-lock-id',
        expires_at: '2026-09-17T23:00:00.000Z',
      },
    ]]);

    // Supabase calls: completed cleanup, current status,
    // instance lookup/status/plan, foreign activity, metadata update, history.
    mockSupabase.then = jest.fn()
      .mockImplementationOnce((res: any) => res({ data: [], error: null })) // recent completed requirements
      .mockImplementationOnce((res: any) => res({
        data: {
          ...mockRequirement,
          title: 'Fresh title',
          metadata: { requirement_execution_generation: 7 },
        },
        error: null,
      })) // current requirement
      .mockImplementationOnce((res: any) => res({ data: [{ id: 'inst-1', instance_type: 'browser' }], error: null })) // remote instance
      .mockImplementationOnce((res: any) => res({ data: { status: 'running' }, error: null })) // instanceData
      .mockImplementationOnce((res: any) => res({ data: null, error: null })) // activePlan
      .mockImplementationOnce((res: any) => res({ data: [], error: null })) // foreignActivity
      .mockImplementationOnce((res: any) => res({ data: null, error: null })) // metadata update
      .mockImplementationOnce((res: any) => res({ data: null, error: null })) // prevStatuses
      .mockImplementationOnce((res: any) => res({ data: null, error: null })); // prevPlans

    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    });
    
    // Set backlog mocks
    (backlogService.isBacklogComplete as jest.Mock).mockReturnValue(false);
    (backlogService.hasOutstandingWork as jest.Mock).mockReturnValue(true);
    (backlogService.outstandingGatingItems as jest.Mock).mockReturnValue([{ id: 'item-1' }]);

    const res = await GET(req);
    const json = await res.json();
    
    expect(res.status).toBe(200);
    expect(json.results[0].started).toBe(true);
    expect(patchRequirementMetadataKeys).toHaveBeenCalledWith({
      requirementId: 'req-1',
      patch: { runner_instance_id: 'inst-1' },
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'claim_requirement_cron_candidates',
      {
        p_max_concurrent: 8,
        p_ttl_seconds: 7200,
        p_excluded_ids: [],
      },
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'activate_requirement_cron_run',
      {
        p_requirement_id: 'req-1',
        p_run_id: 'test-lock-id',
        p_max_concurrent: 8,
        p_ttl_seconds: 7200,
      },
    );
    expect(mockSupabase.select).toHaveBeenCalledWith('*');
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({
        title: 'Fresh title',
        executionGeneration: 7,
        gitRepoKind: 'automation',
        instance_type: 'automation',
      })],
    );
    expect(mockSupabase.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ cron_attempts: 1 }),
      }),
    );
  });
  
  it('reverts on-review requirement to in-progress if there is outstanding work', async () => {
    const mockRequirement = {
      id: 'req-2',
      status: 'on-review',
      site_id: 'site-1',
      backlog: { items: [{ updated_at: new Date().toISOString() }] },
      metadata: {},
      backlog_revision: 4,
      cron: null,
    };

    mockSupabase.then = jest.fn()
      .mockImplementationOnce((res: any) => res({ data: [mockRequirement], error: null })) // recent completed requirements
      .mockImplementationOnce((res: any) => res({ data: null, error: null })); // revert update

    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    });
    
    (backlogService.isBacklogComplete as jest.Mock).mockReturnValue(true);
    (backlogService.hasOutstandingWork as jest.Mock).mockReturnValue(true); // Has work!
    (backlogService.outstandingGatingItems as jest.Mock).mockReturnValue([]); // No core work, just ornamental

    await GET(req);
    
    expect(mockResumeRequirementExecution).toHaveBeenCalledWith(
      'req-2',
      null,
      false,
      'outstanding-backlog:4',
      true,
    );
  });

  it('skips auto-promotion if there is recent outstanding ornamental work', async () => {
    const mockRequirement = {
      id: 'req-3',
      status: 'in-progress',
      site_id: 'site-1',
      backlog: { items: [{ updated_at: new Date().toISOString() }] },
      metadata: {},
      cron: null,
    };
    mockClaimBatches([[
      {
        state: 'claimed',
        requirement: mockRequirement,
        run_id: 'test-lock-id',
        expires_at: '2026-09-17T23:00:00.000Z',
      },
    ]]);

    mockSupabase.then = jest.fn()
      .mockImplementationOnce((res: any) => res({ data: [], error: null })) // recent completed requirements
      .mockImplementationOnce((res: any) => res({ data: { status: 'in-progress' }, error: null })) // current requirement
      .mockImplementationOnce((res: any) => res({ data: { created_at: '2020-01-01T00:00:00.000Z' }, error: null })) // lastStatus before item update
      .mockImplementationOnce((res: any) => res({ data: [{ id: 'inst-1', instance_type: 'browser' }], error: null })) // remote instance
      .mockImplementationOnce((res: any) => res({ data: { status: 'paused' }, error: null })) // instance status
      .mockImplementationOnce((res: any) => res({ data: null, error: null })); // active plan

    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    });
    
    (backlogService.isBacklogComplete as jest.Mock).mockReturnValue(true); // Core is done
    (backlogService.hasOutstandingWork as jest.Mock).mockReturnValue(true); // Has ornamental work
    (backlogService.outstandingGatingItems as jest.Mock).mockReturnValue([]);

    await GET(req);
    
    // Should NOT have called update to on-review
    expect(mockSupabase.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'on-review' }));
  });

  it('continues evaluating candidates after a frozen requirement is skipped', async () => {
    const pausedRequirement = {
      id: 'req-paused',
      status: 'in-progress',
      site_id: 'site-1',
      user_id: 'user-1',
      title: 'Paused work',
      instructions: null,
      type: 'application',
      backlog: { items: [{ id: 'item-1', status: 'pending' }] },
      metadata: { runner_instance_id: 'inst-paused' },
      cron: null,
    };
    const runnableRequirement = {
      ...pausedRequirement,
      id: 'req-runnable',
      title: 'Runnable work',
      metadata: { runner_instance_id: 'inst-runnable' },
    };

    mockClaimBatches([
      [{
          state: 'claimed',
          requirement: pausedRequirement,
          run_id: 'lock-paused',
          expires_at: '2026-09-17T23:00:00.000Z',
      }],
      [{
          state: 'claimed',
          requirement: runnableRequirement,
          run_id: 'lock-runnable',
          expires_at: '2026-09-17T23:00:00.000Z',
      }],
    ]);

    mockSupabase.then = jest.fn()
      .mockImplementationOnce((resolve: any) => resolve({ data: [], error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: pausedRequirement, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: { status: 'paused' }, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: runnableRequirement, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: { status: 'running' }, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: [], error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null }));

    (backlogService.isBacklogComplete as jest.Mock).mockReturnValue(false);
    (backlogService.hasOutstandingWork as jest.Mock).mockReturnValue(true);
    (backlogService.outstandingGatingItems as jest.Mock).mockReturnValue([
      { id: 'item-1' },
    ]);

    const res = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const json = await res.json();

    expect(json.evaluatedRequirements).toBe(2);
    expect(json.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ reqId: 'req-paused', reason: 'paused' }),
      expect.objectContaining({ reqId: 'req-runnable', started: true }),
    ]));
    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      'claim_requirement_cron_candidates',
      expect.objectContaining({
        p_excluded_ids: ['req-paused'],
      }),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not start an evaluated requirement when all work slots are full', async () => {
    const requirement = {
      id: 'req-waiting',
      status: 'in-progress',
      site_id: 'site-1',
      user_id: 'user-1',
      title: 'Waiting work',
      instructions: null,
      type: 'application',
      backlog: { items: [{ id: 'item-1', status: 'pending' }] },
      metadata: { runner_instance_id: 'inst-waiting' },
      cron: null,
    };
    mockClaimBatches(
      [[{
        state: 'claimed',
        requirement,
        run_id: 'lock-waiting',
        expires_at: '2026-09-17T23:00:00.000Z',
      }]],
      { state: 'capacity_full', active_runs: 8 },
    );
    mockSupabase.then = jest.fn()
      .mockImplementationOnce((resolve: any) => resolve({ data: [], error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: requirement, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: { status: 'running' }, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null }))
      .mockImplementationOnce((resolve: any) => resolve({ data: [], error: null }));

    (backlogService.isBacklogComplete as jest.Mock).mockReturnValue(false);
    (backlogService.hasOutstandingWork as jest.Mock).mockReturnValue(true);
    (backlogService.outstandingGatingItems as jest.Mock).mockReturnValue([
      { id: 'item-1' },
    ]);

    const res = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const json = await res.json();

    expect(json.capacityReached).toBe(true);
    expect(json.results).toContainEqual(expect.objectContaining({
      reqId: 'req-waiting',
      reason: 'capacity_full',
    }));
    expect(releaseRunLock).toHaveBeenCalledWith(
      'req-waiting',
      'lock-waiting',
    );
    expect(start).not.toHaveBeenCalled();
  });
});
