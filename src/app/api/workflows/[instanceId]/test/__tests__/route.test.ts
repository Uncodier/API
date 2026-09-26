// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const from = jest.fn();
const hasAuthenticatedPrincipal = jest.fn();
const canAccessSite = jest.fn();
const authorizeWorkflowInstanceWrite = jest.fn();
const materializeRunFromGraph = jest.fn();
const runWorkflowPlan = jest.fn();
let triggerRows: any[] = [];
let triggerNodes: any[] = [];

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal }));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite }));
jest.unstable_mockModule('@/lib/services/workflow-robot/route-access', () => ({ authorizeWorkflowInstanceWrite }));
jest.unstable_mockModule('@/lib/services/workflow-robot/materialize', () => ({ materializeRunFromGraph }));
jest.unstable_mockModule('@/lib/services/workflow-robot/run-plan', () => ({ runWorkflowPlan }));

const { POST } = await import('../route');
const instanceId = '11111111-1111-4111-8111-111111111111';
const triggerNodeId = '22222222-2222-4222-8222-222222222222';
const context = { params: Promise.resolve({ instanceId }) };
const request = (payload: Record<string, unknown> = {}) => new NextRequest('https://api.example/api/workflows/id/test', {
  method: 'POST', body: JSON.stringify({ payload }),
});

beforeEach(() => {
  jest.clearAllMocks();
  triggerRows = [];
  triggerNodes = [];
  hasAuthenticatedPrincipal.mockReturnValue(true);
  canAccessSite.mockResolvedValue(true);
  authorizeWorkflowInstanceWrite.mockResolvedValue(null);
  materializeRunFromGraph.mockResolvedValue({ run_plan_id: 'plan-1' });
  runWorkflowPlan.mockResolvedValue({ status: 'completed', steps_completed: 1 });
  from.mockImplementation((table: string) => {
    const query: any = {};
    query.select = jest.fn().mockReturnValue(query);
    query.eq = jest.fn().mockReturnValue(query);
    query.limit = jest.fn().mockResolvedValue({ data: triggerRows, error: null });
    query.maybeSingle = jest.fn().mockResolvedValue({
      data: table === 'remote_instances' ? { site_id: 'site-1' }
        : { id: 'trigger-row-1', site_id: 'site-1' },
      error: null,
    });
    // instance_nodes returns a filtered array without an explicit .limit call.
    if (table === 'instance_nodes') query.then = (resolve: (value: any) => any) =>
      Promise.resolve({ data: triggerNodes, error: null }).then(resolve);
    return query;
  });
});

it('does not run a dry test for a non-manager', async () => {
  authorizeWorkflowInstanceWrite.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
  expect((await POST(request(), context)).status).toBe(403);
  expect(materializeRunFromGraph).not.toHaveBeenCalled();
});

it('reports failed workflow test as a failure instead of successful execution', async () => {
  runWorkflowPlan.mockResolvedValueOnce({ status: 'failed', steps_completed: 0 });
  const result = await POST(request({ test: true }), context);
  expect(result.status).toBe(422);
  expect(await result.json()).toMatchObject({ success: false, status: 'failed' });
});

it('blocks generic tool-capable tests when the channel trigger is not yet synced', async () => {
  triggerNodes = [{ settings: { trigger: { active_kinds: ['manual', 'channel_message'] } } }];
  expect((await POST(request(), context)).status).toBe(400);
  expect(materializeRunFromGraph).not.toHaveBeenCalled();
});

it('explicitly rejects the unbounded channel test runner even for authorized managers', async () => {
  const response = await POST(request({ source: 'channel_message', trigger_id: triggerNodeId }), context);
  expect(response.status).toBe(422);
  expect(materializeRunFromGraph).not.toHaveBeenCalled();
  expect(runWorkflowPlan).not.toHaveBeenCalled();
});