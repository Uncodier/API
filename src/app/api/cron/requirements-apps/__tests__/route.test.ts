import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';

// Mocks
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('workflow/api', () => ({
  start: jest.fn().mockResolvedValue({ runId: 'test-workflow-run-id' }),
}));

jest.mock('../workflow', () => ({
  runCronAppsWorkflow: jest.fn(),
}));

jest.mock('../../maintenance/workflow', () => ({
  runMaintenanceWorkflow: jest.fn(),
}));

jest.mock('../../shared/cron-run-lock', () => ({
  acquireRunLock: jest.fn().mockResolvedValue({ runId: 'test-lock-id' }),
  releaseRunLock: jest.fn().mockResolvedValue(true),
  getSupabaseUrlHostForLogs: jest.fn().mockReturnValue('mock-host'),
}));

jest.mock('@/lib/services/requirement-backlog', () => ({
  isBacklogComplete: jest.fn(),
  hasOutstandingWork: jest.fn(),
  outstandingGatingItems: jest.fn(),
}));

jest.mock('@/lib/services/requirement-onreview-sanitizer', () => ({
  runOnReviewSanitization: jest.fn().mockResolvedValue({ requirementsSanitized: 0, itemsReopened: 0 }),
}));

import { GET } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import * as backlogService from '@/lib/services/requirement-backlog';

describe('Cron Requirements Apps Route', () => {
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';

    mockSupabase = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      like: jest.fn().mockReturnThis(),
      then: function(resolve) { resolve({ data: [], error: null }); },
    };

    (supabaseAdmin.from as jest.Mock).mockReturnValue(mockSupabase);
  });

  it('returns 401 without correct authorization header', async () => {
    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('processes requirements successfully', async () => {
    // Mock the initial query for requirements
    const mockRequirement = {
      id: 'req-1',
      status: 'in-progress',
      site_id: 'site-1',
      backlog: { items: [] },
      metadata: {},
      cron: null,
    };

    // First call is for due requirements
    mockSupabase.then = jest.fn()
      .mockImplementationOnce((res: any) => res({ data: [mockRequirement], error: null })) // due requirements
      .mockImplementationOnce((res: any) => res({ data: { created_at: '2023-01-01T00:00:00.000Z' }, error: null })) // lastStatus
      .mockImplementationOnce((res: any) => res({ data: [{ id: 'inst-1' }], error: null })) // remote_instances
      .mockImplementationOnce((res: any) => res({ data: { status: 'running' }, error: null })) // instanceData
      .mockImplementationOnce((res: any) => res({ data: null, error: null })) // activePlan
      .mockImplementationOnce((res: any) => res({ data: null, error: null })) // foreignActivity
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
  });
  
  it('reverts on-review requirement to in-progress if there is outstanding work', async () => {
    const mockRequirement = {
      id: 'req-2',
      status: 'on-review',
      site_id: 'site-1',
      backlog: { items: [{ updated_at: new Date().toISOString() }] },
      metadata: {},
      cron: null,
    };

    mockSupabase.then = jest.fn()
      .mockImplementationOnce((res: any) => res({ data: [mockRequirement], error: null })) // due requirements
      .mockImplementationOnce((res: any) => res({ data: { created_at: '2020-01-01T00:00:00.000Z' }, error: null })) // lastStatus
      .mockImplementationOnce((res: any) => res({ data: [{ id: 'inst-1' }], error: null })); // instances

    const req = new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    });
    
    (backlogService.isBacklogComplete as jest.Mock).mockReturnValue(true);
    (backlogService.hasOutstandingWork as jest.Mock).mockReturnValue(true); // Has work!
    (backlogService.outstandingGatingItems as jest.Mock).mockReturnValue([]); // No core work, just ornamental

    await GET(req);
    
    // Should have called update to in-progress
    expect(supabaseAdmin.from).toHaveBeenCalledWith('requirements');
    expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'in-progress' });
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

    mockSupabase.then = jest.fn()
      .mockImplementationOnce((res: any) => res({ data: [mockRequirement], error: null })) // due requirements
      .mockImplementationOnce((res: any) => res({ data: { created_at: '2020-01-01T00:00:00.000Z' }, error: null })); // lastStatus before the item update

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
});
