const principal = jest.fn();
const access = jest.fn();
const procurement = jest.fn();
const from = jest.fn();
const resolveRouting = jest.fn();
const handler = jest.fn();
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: principal, canToolPrincipalAccessSite: access }));
jest.mock('@/lib/services/workflow-robot/procurement-access', () => ({ canReadProcurementWorkflowInstanceAsActor: procurement }));
jest.mock('@/lib/services/ai/customer-routing-http', () => ({ resolveHttpExecutionRouting: resolveRouting,
  withHttpExecutionRouting: async (_r: any, _pin: any, run: any) => run() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
import { NextRequest, NextResponse } from 'next/server';
import { admitActRequest } from '@/app/api/robots/instance/act/admission';
const site = '11111111-1111-4111-8111-111111111111';
const instance = '22222222-2222-4222-8222-222222222222';
function request(fields = {}) {
  return new NextRequest('https://api.example.test/api/robots/instance/act', { method: 'POST', body: JSON.stringify({ instance_id: instance, ...fields }) });
}
beforeEach(() => {
  jest.clearAllMocks();
  principal.mockResolvedValue({ internal: false, userId: 'actor', siteId: site });
  access.mockResolvedValue(true); procurement.mockResolvedValue(true);
  resolveRouting.mockResolvedValue({ payer: 'platform', siteId: site });
  handler.mockResolvedValue(NextResponse.json({ success: true }));
  from.mockImplementation(() => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { site_id: site }, error: null }) }) }) }));
});
it('authenticates before resource reads', async () => {
  principal.mockResolvedValue(null);
  expect((await admitActRequest(request(), handler)).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
it.each([{ site_id: instance }, { user_id: 'victim' }])('rejects forged authority %j', async fields => {
  expect((await admitActRequest(request(fields), handler)).status).toBe(403);
  expect(resolveRouting).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
it('denies cross-site principals before provisioning or selecting a payer', async () => {
  access.mockResolvedValue(false);
  expect((await admitActRequest(request(), handler)).status).toBe(403);
  expect(resolveRouting).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
it('preserves authorized legacy site-less requests using the stored instance site', async () => {
  const req = request();
  expect((await admitActRequest(req, handler)).status).toBe(200);
  expect(resolveRouting).toHaveBeenCalledWith(req, site);
  expect(handler).toHaveBeenCalledWith(req);
});