const authorize = jest.fn();
const scope = jest.fn(async (_r: any, _pin: any, operation: any) => operation());
const pin = jest.fn();
const from = jest.fn();
const procurement = jest.fn();
const events: string[] = [];
let inserted: any;
jest.mock('@/lib/services/ai/customer-routing-http', () => ({ authorizeInferenceRequest: authorize, withHttpExecutionRouting: scope }));
jest.mock('@/lib/services/workflow-robot/procurement-access', () => ({ canReadProcurementWorkflowInstanceAsActor: procurement }));
jest.mock('@/lib/services/ai/customer-routing', () => ({ getExecutionRouting: () => ({ payer: 'platform', siteId: site }) }));
jest.mock('@/lib/services/workflow-robot/plan-routing', () => ({ pinPlanRouting: pin }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.mock('@/lib/helpers/robot-planning-core', () => ({ formatPlanSteps: () => [], addSessionSaveSteps: () => [], calculateEstimatedDuration: () => 10, executeUnifiedRobotActivityPlanning: jest.fn() }));
jest.mock('@/lib/helpers/agent-finder', () => ({ findGrowthRobotAgent: async () => ({ agentId: 'agent', userId: 'actor' }) }));
jest.mock('@/lib/helpers/plan-lifecycle', () => ({ completeInProgressPlans: async () => {} }));
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agents/growth/robot/plan/route';
const site = '11111111-1111-4111-8111-111111111111';
const instance = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
function request(fields = {}) {
  return new NextRequest('https://api.example.test/api/agents/growth/robot/plan', { method: 'POST', body: JSON.stringify({ site_id: site, instance_id: instance, user_id: actor, activity: 'ask', ...fields }) });
}
beforeEach(() => {
  jest.clearAllMocks(); events.length = 0;
  authorize.mockResolvedValue({ principal: { internal: false, userId: actor }, routing: { payer: 'platform', siteId: site } });
  procurement.mockResolvedValue(true);
  pin.mockImplementation(async () => { events.push('pin'); });
  from.mockImplementation((table: string) => {
    const q: any = { select: () => q, eq: () => q,
      insert: (data: any) => { inserted = data; events.push('insert'); return q; },
      update: (data: any) => { events.push(data.status); return q; },
      single: async () => ({ data: table === 'remote_instances' ? { site_id: site } : { id: 'plan' }, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    }; return q;
  });
});
it('rejects unauthenticated before database actions', async () => {
  authorize.mockRejectedValueOnce(Object.assign(new Error(), { status: 401 }));
  expect((await POST(request())).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
});
it('rejects a spoofed user even with site access', async () => {
  expect((await POST(request({ user_id: instance }))).status).toBe(403);
  expect(from).not.toHaveBeenCalled();
});
it('requires resource permissions before accessing sessions or replacing plans', async () => {
  procurement.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(from).not.toHaveBeenCalled();
});
it('pins before publishing generated steps', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(inserted.status).toBe('blocked');
  expect(events).toEqual(['insert', 'pin', 'pending']);
});
it('never publishes when the immutable pin fails', async () => {
  pin.mockRejectedValueOnce(new Error('offline'));
  expect((await POST(request())).status).toBe(400);
  expect(events).toEqual(['insert']);
});