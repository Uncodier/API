const principal = jest.fn();
const access = jest.fn();
const procurement = jest.fn();
const routing = jest.fn();
const pin = jest.fn();
const from = jest.fn();
const events: string[] = [];
let inserted: any;
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: principal, canToolPrincipalAccessSite: access }));
jest.mock('@/lib/services/workflow-robot/procurement-access', () => ({ canReadProcurementWorkflowInstanceAsActor: procurement }));
jest.mock('@/lib/services/ai/customer-routing-http', () => ({ resolveHttpExecutionRouting: routing }));
jest.mock('@/lib/services/workflow-robot/plan-routing', () => ({ pinPlanRouting: pin }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
import { createPlan } from '@/app/api/instances/[id]/plans/create';
const site = '11111111-1111-4111-8111-111111111111';
const instance = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
function request(body: unknown = { title: 'A plan' }) {
  return new Request('https://api.example.test/api/instances/x/plans', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  jest.clearAllMocks(); events.length = 0; inserted = undefined;
  principal.mockResolvedValue({ internal: false, userId: actor, siteId: site });
  access.mockResolvedValue(true); procurement.mockResolvedValue(true);
  routing.mockResolvedValue({ payer: 'platform', siteId: site });
  pin.mockImplementation(async () => { events.push('pin'); });
  from.mockImplementation((table: string) => {
    const q: any = {
      select: () => q, eq: () => q,
      insert: (data: any) => { inserted = data; events.push('insert'); return q; },
      update: () => { events.push('publish'); return q; },
      single: async () => ({ data: table === 'remote_instances' ? { site_id: site, user_id: 'owner' } : { ...inserted, id: 'plan' }, error: null }),
      then: (resolve: any) => resolve({ error: null }),
    }; return q;
  });
});
it('requires a real principal before reading instances', async () => {
  principal.mockResolvedValue(null);
  expect((await createPlan(request(), instance)).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
});
it.each([{ payer: 'platform' }, { site_id: site }, { user_id: actor }, { metadata: { payer: 'customer' } }, { status: 'active' }])(
  'rejects caller-controlled authority/runnable state %j', async fields => {
    expect((await createPlan(request({ title: 'Plan', ...fields }), instance)).status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
it.each(['membership', 'procurement'])('denies %s before selection or mutation', async check => {
  (check === 'membership' ? access : procurement).mockResolvedValue(false);
  expect((await createPlan(request(), instance)).status).toBe(403);
  expect(routing).not.toHaveBeenCalled();
  expect(inserted).toBeUndefined();
});
it.each(['platform', 'customer'])('pins authoritative %s routing before making a plan runnable', async payer => {
  const ref = payer === 'platform' ? { payer, siteId: site } : { payer, siteId: site, connectionId: 'connection', policyVersion: 1, credentialVersion: 2 };
  routing.mockResolvedValue(ref);
  const response = await createPlan(request(), instance);
  expect(response.status).toBe(201);
  expect(events).toEqual(['insert', 'pin', 'publish']);
  expect(inserted).toMatchObject({ status: 'blocked', site_id: site, user_id: actor, instance_id: instance });
  expect(pin).toHaveBeenCalledWith('plan', site, ref);
  expect((await response.json()).plan.status).toBe('pending');
});
it('keeps a plan non-runnable if pin storage fails', async () => {
  pin.mockRejectedValueOnce(new Error('offline'));
  expect((await createPlan(request(), instance)).status).toBe(503);
  expect(events).toEqual(['insert']);
  expect(inserted.status).toBe('blocked');
});